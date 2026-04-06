import { getPool } from "./db.js";
import { PLANS, PlanKey } from "./stripe.js";

// Returns YYYY-MM for the current billing period
function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export interface UsageInfo {
  plan: PlanKey;
  used: number;
  limit: number;
  nearLimit: boolean; // >= 80% used
  overLimit: boolean;
  periodStart: string; // YYYY-MM
}

export async function getUserPlan(userId: string): Promise<PlanKey> {
  const pool = getPool();
  const result = await pool.query<{ tier: string }>(
    "SELECT tier FROM users WHERE id = $1",
    [userId]
  );
  const tier = result.rows[0]?.tier ?? "free";
  return (tier in PLANS ? tier : "free") as PlanKey;
}

export async function getUsageInfo(userId: string): Promise<UsageInfo> {
  const pool = getPool();
  const period = currentPeriod();

  const [planKey, usageResult] = await Promise.all([
    getUserPlan(userId),
    pool.query<{ count: string }>(
      "SELECT count FROM usage_records WHERE user_id = $1 AND period_start = date_trunc('month', NOW())::date",
      [userId]
    ),
  ]);

  const used = parseInt(usageResult.rows[0]?.count ?? "0", 10);
  const limit = PLANS[planKey].monthlyLimit;

  return {
    plan: planKey,
    used,
    limit,
    nearLimit: isFinite(limit) && used / limit >= 0.8,
    overLimit: isFinite(limit) && used >= limit,
    periodStart: period,
  };
}

export async function incrementUsage(userId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO usage_records (user_id, period_start, count, updated_at)
     VALUES ($1, date_trunc('month', NOW())::date, 1, NOW())
     ON CONFLICT (user_id, period_start)
     DO UPDATE SET count = usage_records.count + 1, updated_at = NOW()`,
    [userId]
  );
}

export async function getOrCreateStripeCustomer(
  userId: string,
  email: string
): Promise<string> {
  const pool = getPool();
  const result = await pool.query<{ stripe_customer_id: string | null }>(
    "SELECT stripe_customer_id FROM users WHERE id = $1",
    [userId]
  );
  const existing = result.rows[0]?.stripe_customer_id;
  if (existing) return existing;

  // Caller creates the Stripe customer and then stores it
  throw new Error("stripe_customer_id not set — call createStripeCustomer first");
}

export async function storeStripeCustomerId(
  userId: string,
  stripeCustomerId: string
): Promise<void> {
  const pool = getPool();
  await pool.query(
    "UPDATE users SET stripe_customer_id = $1 WHERE id = $2",
    [stripeCustomerId, userId]
  );
}

export async function syncSubscription(opts: {
  stripeSubscriptionId: string;
  stripeCustomerId: string;
  plan: PlanKey;
  status: string;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
}): Promise<void> {
  const pool = getPool();

  // Look up user by stripe_customer_id
  const userResult = await pool.query<{ id: string }>(
    "SELECT id FROM users WHERE stripe_customer_id = $1",
    [opts.stripeCustomerId]
  );
  const userId = userResult.rows[0]?.id;
  if (!userId) return;

  // Derive tier from plan status
  const activePlan: PlanKey = opts.status === "active" || opts.status === "trialing" ? opts.plan : "free";

  await pool.query(
    `INSERT INTO subscriptions
       (user_id, stripe_subscription_id, stripe_customer_id, plan, status, current_period_end, cancel_at_period_end, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (stripe_subscription_id)
     DO UPDATE SET
       plan = EXCLUDED.plan,
       status = EXCLUDED.status,
       current_period_end = EXCLUDED.current_period_end,
       cancel_at_period_end = EXCLUDED.cancel_at_period_end,
       updated_at = NOW()`,
    [
      userId,
      opts.stripeSubscriptionId,
      opts.stripeCustomerId,
      opts.plan,
      opts.status,
      opts.currentPeriodEnd,
      opts.cancelAtPeriodEnd,
    ]
  );

  await pool.query("UPDATE users SET tier = $1 WHERE id = $2", [activePlan, userId]);
}

export async function getSubscription(userId: string) {
  const pool = getPool();
  const result = await pool.query(
    `SELECT s.plan, s.status, s.current_period_end, s.cancel_at_period_end,
            u.tier
     FROM users u
     LEFT JOIN subscriptions s ON s.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  );
  return result.rows[0] ?? null;
}
