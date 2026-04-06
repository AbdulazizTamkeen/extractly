import crypto from "crypto";
import bcrypt from "bcryptjs";
import { getPool } from "./db.js";

const API_KEY_PREFIX = "ex_";
const BCRYPT_ROUNDS = 10;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function generateApiKey(): { raw: string; prefix: string } {
  const token = crypto.randomBytes(32).toString("hex");
  const raw = `${API_KEY_PREFIX}${token}`;
  const prefix = raw.slice(0, 12); // "ex_" + first 9 chars
  return { raw, prefix };
}

export async function hashApiKey(raw: string): Promise<string> {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export interface ApiKeyRecord {
  id: string;
  userId: string;
  keyPrefix: string;
  name: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface UserRecord {
  id: string;
  email: string;
  createdAt: Date;
}

export async function createUser(
  email: string,
  password: string
): Promise<UserRecord> {
  const pool = getPool();
  const passwordHash = await hashPassword(password);
  const result = await pool.query<{
    id: string;
    email: string;
    created_at: Date;
  }>(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at",
    [email.toLowerCase().trim(), passwordHash]
  );
  const row = result.rows[0];
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

export async function findUserByEmail(
  email: string
): Promise<{ id: string; email: string; passwordHash: string } | null> {
  const pool = getPool();
  const result = await pool.query<{
    id: string;
    email: string;
    password_hash: string;
  }>("SELECT id, email, password_hash FROM users WHERE email = $1", [
    email.toLowerCase().trim(),
  ]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return { id: row.id, email: row.email, passwordHash: row.password_hash };
}

export async function createApiKey(
  userId: string,
  name: string
): Promise<{ record: ApiKeyRecord; rawKey: string }> {
  const pool = getPool();
  const { raw, prefix } = generateApiKey();
  const keyHash = await hashApiKey(raw);
  const result = await pool.query<{
    id: string;
    user_id: string;
    key_prefix: string;
    name: string;
    last_used_at: Date | null;
    revoked_at: Date | null;
    created_at: Date;
  }>(
    `INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, key_prefix, name, last_used_at, revoked_at, created_at`,
    [userId, keyHash, prefix, name]
  );
  const row = result.rows[0];
  return {
    record: {
      id: row.id,
      userId: row.user_id,
      keyPrefix: row.key_prefix,
      name: row.name,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
    },
    rawKey: raw,
  };
}

export async function listApiKeys(userId: string): Promise<ApiKeyRecord[]> {
  const pool = getPool();
  const result = await pool.query<{
    id: string;
    user_id: string;
    key_prefix: string;
    name: string;
    last_used_at: Date | null;
    revoked_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, user_id, key_prefix, name, last_used_at, revoked_at, created_at
     FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    keyPrefix: row.key_prefix,
    name: row.name,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  }));
}

export async function revokeApiKey(
  keyId: string,
  userId: string
): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE api_keys SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [keyId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function rotateApiKey(
  keyId: string,
  userId: string
): Promise<{ record: ApiKeyRecord; rawKey: string } | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Revoke old key
    const revoke = await client.query(
      `UPDATE api_keys SET revoked_at = NOW()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING name`,
      [keyId, userId]
    );
    if ((revoke.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const name = revoke.rows[0].name as string;
    // Create new key
    const { raw, prefix } = generateApiKey();
    const keyHash = await hashApiKey(raw);
    const insert = await client.query<{
      id: string;
      user_id: string;
      key_prefix: string;
      name: string;
      last_used_at: Date | null;
      revoked_at: Date | null;
      created_at: Date;
    }>(
      `INSERT INTO api_keys (user_id, key_hash, key_prefix, name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, key_prefix, name, last_used_at, revoked_at, created_at`,
      [userId, keyHash, prefix, name]
    );
    await client.query("COMMIT");
    const row = insert.rows[0];
    return {
      record: {
        id: row.id,
        userId: row.user_id,
        keyPrefix: row.key_prefix,
        name: row.name,
        lastUsedAt: row.last_used_at,
        revokedAt: row.revoked_at,
        createdAt: row.created_at,
      },
      rawKey: raw,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function validateApiKey(
  rawKey: string
): Promise<{ userId: string; keyId: string } | null> {
  if (!rawKey.startsWith("ex_")) return null;
  const pool = getPool();
  const prefix = rawKey.slice(0, 12);
  const keyHash = await hashApiKey(rawKey);
  const result = await pool.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM api_keys
     WHERE key_prefix = $1 AND key_hash = $2 AND revoked_at IS NULL`,
    [prefix, keyHash]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  // Update last_used_at asynchronously
  pool
    .query("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1", [row.id])
    .catch(() => undefined);
  return { userId: row.user_id, keyId: row.id };
}
