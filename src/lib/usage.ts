import { getPool } from "./db.js";

export type Tier = "free" | "basic" | "pro" | "enterprise";

const TIER_LIMITS: Record<Tier, number | null> = {
  free: 100,
  basic: 2000,
  pro: 10000,
  enterprise: null, // unlimited
};

export function getTierLimit(tier: Tier): number | null {
  return TIER_LIMITS[tier] ?? 100;
}

export function getPeriodStart(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export function getNextPeriodStart(): string {
  const now = new Date();
  const year = now.getUTCMonth() === 11 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  const month = now.getUTCMonth() === 11 ? 1 : now.getUTCMonth() + 2;
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

export interface UsageInfo {
  used: number;
  limit: number | null;
  remaining: number | null;
  periodStart: string;
  periodEnd: string;
  tier: Tier;
}

export interface CheckUsageResult {
  allowed: boolean;
  used: number;
  limit: number | null;
  remaining: number | null;
  periodStart: string;
  periodEnd: string;
}

export async function checkAndIncrementUsage(
  userId: string
): Promise<CheckUsageResult> {
  const pool = getPool();
  const periodStart = getPeriodStart();
  const periodEnd = getNextPeriodStart();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Get user tier
    const userResult = await client.query<{ tier: string }>(
      "SELECT tier FROM users WHERE id = $1",
      [userId]
    );
    const tier = ((userResult.rows[0]?.tier ?? "free") as Tier);
    const limit = getTierLimit(tier);

    // Ensure row exists then lock it
    await client.query(
      `INSERT INTO usage_records (user_id, period_start, count)
       VALUES ($1, $2, 0)
       ON CONFLICT (user_id, period_start) DO NOTHING`,
      [userId, periodStart]
    );

    const lockResult = await client.query<{ count: number }>(
      `SELECT count FROM usage_records
       WHERE user_id = $1 AND period_start = $2
       FOR UPDATE`,
      [userId, periodStart]
    );

    const currentCount = lockResult.rows[0]?.count ?? 0;

    if (limit !== null && currentCount >= limit) {
      await client.query("ROLLBACK");
      return {
        allowed: false,
        used: currentCount,
        limit,
        remaining: 0,
        periodStart,
        periodEnd,
      };
    }

    const updated = await client.query<{ count: number }>(
      `UPDATE usage_records
       SET count = count + 1, updated_at = NOW()
       WHERE user_id = $1 AND period_start = $2
       RETURNING count`,
      [userId, periodStart]
    );

    await client.query("COMMIT");
    const newCount = updated.rows[0].count;

    return {
      allowed: true,
      used: newCount,
      limit,
      remaining: limit === null ? null : limit - newCount,
      periodStart,
      periodEnd,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getUsageInfo(userId: string): Promise<UsageInfo> {
  const pool = getPool();
  const periodStart = getPeriodStart();
  const periodEnd = getNextPeriodStart();

  const [userResult, usageResult] = await Promise.all([
    pool.query<{ tier: string }>(
      "SELECT tier FROM users WHERE id = $1",
      [userId]
    ),
    pool.query<{ count: number }>(
      "SELECT count FROM usage_records WHERE user_id = $1 AND period_start = $2",
      [userId, periodStart]
    ),
  ]);

  const tier = ((userResult.rows[0]?.tier ?? "free") as Tier);
  const limit = getTierLimit(tier);
  const used = usageResult.rows[0]?.count ?? 0;

  return {
    used,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
    periodStart,
    periodEnd,
    tier,
  };
}
