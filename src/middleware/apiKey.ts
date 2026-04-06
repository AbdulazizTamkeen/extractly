import { FastifyRequest, FastifyReply } from "fastify";
import { validateApiKey } from "../lib/auth.js";
import { checkAndIncrementUsage, CheckUsageResult } from "../lib/usage.js";

export async function apiKeyMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return reply
      .status(401)
      .send({ error: "Missing or invalid Authorization header" });
  }
  const rawKey = authHeader.slice(7).trim();
  const result = await validateApiKey(rawKey);
  if (!result) {
    return reply.status(401).send({ error: "Invalid or revoked API key" });
  }
  request.apiKeyUserId = result.userId;
  request.apiKeyId = result.keyId;

  const usage = await checkAndIncrementUsage(result.userId);
  if (!usage.allowed) {
    reply.header("X-RateLimit-Limit", String(usage.limit ?? "unlimited"));
    reply.header("X-RateLimit-Remaining", "0");
    reply.header("X-RateLimit-Used", String(usage.used));
    reply.header("X-RateLimit-Reset", usage.periodEnd);
    return reply.status(429).send({
      error: "Monthly extraction limit reached",
      limit: usage.limit,
      used: usage.used,
      periodEnd: usage.periodEnd,
    });
  }

  request.usageInfo = usage;
}

// Extend Fastify request type
declare module "fastify" {
  interface FastifyRequest {
    apiKeyUserId?: string;
    apiKeyId?: string;
    usageInfo?: CheckUsageResult;
  }
}
