import Stripe from "stripe";

export const PLANS = {
  free: {
    name: "Free",
    monthlyLimit: 100,
    stripePriceId: null as string | null,
  },
  pro: {
    name: "Pro",
    monthlyLimit: 5000,
    stripePriceId: process.env.STRIPE_PRO_PRICE_ID ?? null,
  },
  business: {
    name: "Business",
    monthlyLimit: Infinity,
    stripePriceId: process.env.STRIPE_BUSINESS_PRICE_ID ?? null,
  },
} as const;

export type PlanKey = keyof typeof PLANS;

export function getStripe(): Stripe.Stripe {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error("STRIPE_SECRET_KEY environment variable is required");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new (Stripe as any)(secretKey) as Stripe.Stripe;
}
