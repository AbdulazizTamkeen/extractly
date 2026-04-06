import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getStripe, PLANS, PlanKey } from "../lib/stripe.js";

type StripeInstance = ReturnType<typeof getStripe>;
type StripeEvent = ReturnType<StripeInstance["webhooks"]["constructEvent"]>;
type StripeSubscription = Awaited<ReturnType<StripeInstance["subscriptions"]["retrieve"]>>;
import {
  getUsageInfo,
  storeStripeCustomerId,
  syncSubscription,
  getSubscription,
} from "../lib/billing.js";
import { getPool } from "../lib/db.js";

interface CheckoutBody {
  plan: PlanKey;
  successUrl: string;
  cancelUrl: string;
}

interface PortalBody {
  returnUrl: string;
}

function planFromPriceId(priceId: string): PlanKey {
  if (priceId === PLANS.pro.stripePriceId) return "pro";
  if (priceId === PLANS.business.stripePriceId) return "business";
  return "free";
}

export async function billingRoutes(fastify: FastifyInstance) {
  // GET /billing/subscription — current subscription and usage info
  fastify.get(
    "/billing/subscription",
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request.user as { sub: string }).sub;
      const [sub, usage] = await Promise.all([
        getSubscription(userId),
        getUsageInfo(userId),
      ]);
      return reply.send({
        plan: usage.plan,
        used: usage.used,
        limit: isFinite(usage.limit) ? usage.limit : null,
        nearLimit: usage.nearLimit,
        periodStart: usage.periodStart,
        subscription: sub
          ? {
              status: sub.status,
              currentPeriodEnd: sub.current_period_end,
              cancelAtPeriodEnd: sub.cancel_at_period_end,
            }
          : null,
        upgradeCta:
          usage.nearLimit || usage.overLimit
            ? {
                message: usage.overLimit
                  ? "You have reached your monthly extraction limit. Upgrade to continue."
                  : "You are approaching your monthly limit. Upgrade for more extractions.",
                plans: [
                  { key: "pro", name: PLANS.pro.name, limit: PLANS.pro.monthlyLimit },
                  { key: "business", name: PLANS.business.name, limit: null },
                ],
              }
            : null,
      });
    }
  );

  // POST /billing/checkout — create Stripe checkout session to upgrade plan
  fastify.post<{ Body: CheckoutBody }>(
    "/billing/checkout",
    { preHandler: [fastify.authenticate] },
    async (
      request: FastifyRequest<{ Body: CheckoutBody }>,
      reply: FastifyReply
    ) => {
      const userId = (request.user as { sub: string }).sub;
      const { plan, successUrl, cancelUrl } = request.body ?? {};

      if (!plan || !successUrl || !cancelUrl) {
        return reply
          .status(400)
          .send({ error: "plan, successUrl, and cancelUrl are required" });
      }
      if (plan === "free") {
        return reply
          .status(400)
          .send({ error: "Cannot checkout for the free plan" });
      }
      const priceId = PLANS[plan]?.stripePriceId;
      if (!priceId) {
        return reply.status(400).send({
          error: `Invalid plan or Stripe price not configured for '${plan}'`,
        });
      }

      const stripe = getStripe();
      const pool = getPool();

      const userResult = await pool.query<{
        email: string;
        stripe_customer_id: string | null;
      }>("SELECT email, stripe_customer_id FROM users WHERE id = $1", [userId]);
      const user = userResult.rows[0];
      if (!user) return reply.status(404).send({ error: "User not found" });

      let customerId = user.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: { userId },
        });
        customerId = customer.id;
        await storeStripeCustomerId(userId, customerId);
      }

      // If already subscribed, redirect to billing portal to change plan
      const existingSubs = await stripe.subscriptions.list({
        customer: customerId,
        status: "active",
      });
      if (existingSubs.data.length > 0) {
        const portalSession = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: cancelUrl,
        });
        return reply.send({ url: portalSession.url, mode: "portal" });
      }

      const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        subscription_data: {
          metadata: { userId, plan },
        },
      });

      return reply.send({ url: session.url, sessionId: session.id });
    }
  );

  // POST /billing/portal — Stripe customer portal for managing subscription
  fastify.post<{ Body: PortalBody }>(
    "/billing/portal",
    { preHandler: [fastify.authenticate] },
    async (
      request: FastifyRequest<{ Body: PortalBody }>,
      reply: FastifyReply
    ) => {
      const userId = (request.user as { sub: string }).sub;
      const { returnUrl } = request.body ?? {};
      if (!returnUrl) {
        return reply.status(400).send({ error: "returnUrl is required" });
      }

      const pool = getPool();
      const userResult = await pool.query<{ stripe_customer_id: string | null }>(
        "SELECT stripe_customer_id FROM users WHERE id = $1",
        [userId]
      );
      const customerId = userResult.rows[0]?.stripe_customer_id;
      if (!customerId) {
        return reply.status(400).send({
          error: "No billing account found. Please subscribe first.",
        });
      }

      const stripe = getStripe();
      const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });
      return reply.send({ url: session.url });
    }
  );

  // POST /billing/webhook — Stripe webhook to sync subscription state
  fastify.post(
    "/billing/webhook",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!webhookSecret) {
        fastify.log.error("STRIPE_WEBHOOK_SECRET not set");
        return reply.status(500).send({ error: "Webhook not configured" });
      }

      const sig = request.headers["stripe-signature"] as string;
      if (!sig) {
        return reply
          .status(400)
          .send({ error: "Missing stripe-signature header" });
      }

      const stripe = getStripe();
      let event: StripeEvent;
      try {
        const raw = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
        event = stripe.webhooks.constructEvent(
          raw ?? Buffer.from(JSON.stringify(request.body)),
          sig,
          webhookSecret
        );
      } catch (err: unknown) {
        const e = err as Error;
        fastify.log.warn({ err }, "Stripe webhook signature verification failed");
        return reply
          .status(400)
          .send({ error: `Webhook error: ${e.message}` });
      }

      try {
        await handleStripeEvent(event);
      } catch (err) {
        fastify.log.error(
          { err, eventType: event.type },
          "Error handling Stripe event"
        );
        // Return 200 so Stripe doesn't retry — logged internally
      }

      return reply.status(200).send({ received: true });
    }
  );
}

async function handleStripeEvent(event: StripeEvent): Promise<void> {
  const subscription = event.data.object as StripeSubscription;

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const firstItem = subscription.items.data[0];
      const priceId = firstItem?.price?.id ?? "";
      const plan = planFromPriceId(priceId);
      // In Stripe v22, current_period_end is on SubscriptionItem
      const periodEndTs = firstItem?.current_period_end ?? subscription.billing_cycle_anchor;
      await syncSubscription({
        stripeSubscriptionId: subscription.id,
        stripeCustomerId: subscription.customer as string,
        plan,
        status: subscription.status,
        currentPeriodEnd: new Date(periodEndTs * 1000),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      });
      break;
    }
    case "customer.subscription.deleted": {
      const firstItem = subscription.items.data[0];
      const periodEndTs = firstItem?.current_period_end ?? subscription.billing_cycle_anchor;
      await syncSubscription({
        stripeSubscriptionId: subscription.id,
        stripeCustomerId: subscription.customer as string,
        plan: "free",
        status: "canceled",
        currentPeriodEnd: new Date(periodEndTs * 1000),
        cancelAtPeriodEnd: false,
      });
      break;
    }
    default:
      break;
  }
}
