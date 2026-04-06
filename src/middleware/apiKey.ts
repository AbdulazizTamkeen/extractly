import { FastifyRequest, FastifyReply } from "fastify";
import { validateApiKey } from "../lib/auth.js";

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
}

// Extend Fastify request type
declare module "fastify" {
  interface FastifyRequest {
    apiKeyUserId?: string;
    apiKeyId?: string;
  }
}
