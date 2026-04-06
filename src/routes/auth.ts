import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  createUser,
  findUserByEmail,
  verifyPassword,
  createApiKey,
  listApiKeys,
  revokeApiKey,
  rotateApiKey,
} from "../lib/auth.js";
import { getUsageInfo } from "../lib/usage.js";

interface RegisterBody {
  email: string;
  password: string;
}

interface LoginBody {
  email: string;
  password: string;
}

interface CreateKeyBody {
  name?: string;
}

interface KeyParams {
  id: string;
}

export async function authRoutes(fastify: FastifyInstance) {
  // POST /auth/register
  fastify.post(
    "/auth/register",
    async (
      request: FastifyRequest<{ Body: RegisterBody }>,
      reply: FastifyReply
    ) => {
      const { email, password } = request.body ?? {};
      if (!email || !password) {
        return reply.status(400).send({ error: "email and password required" });
      }
      if (password.length < 8) {
        return reply
          .status(400)
          .send({ error: "password must be at least 8 characters" });
      }
      try {
        const user = await createUser(email, password);
        const token = fastify.jwt.sign({ sub: user.id, email: user.email });
        return reply.status(201).send({ token, userId: user.id });
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e.code === "23505") {
          return reply.status(409).send({ error: "email already registered" });
        }
        fastify.log.error(err);
        return reply.status(500).send({ error: "registration failed" });
      }
    }
  );

  // POST /auth/login
  fastify.post(
    "/auth/login",
    async (
      request: FastifyRequest<{ Body: LoginBody }>,
      reply: FastifyReply
    ) => {
      const { email, password } = request.body ?? {};
      if (!email || !password) {
        return reply.status(400).send({ error: "email and password required" });
      }
      const user = await findUserByEmail(email);
      if (!user) {
        return reply.status(401).send({ error: "invalid credentials" });
      }
      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        return reply.status(401).send({ error: "invalid credentials" });
      }
      const token = fastify.jwt.sign({ sub: user.id, email: user.email });
      return reply.send({ token, userId: user.id });
    }
  );

  // All key management routes require JWT authentication
  // POST /auth/keys — create API key
  fastify.post<{ Body: CreateKeyBody }>(
    "/auth/keys",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const name = (request.body as CreateKeyBody | undefined)?.name ?? "default";
      const { record, rawKey } = await createApiKey(userId, name);
      return reply.status(201).send({
        id: record.id,
        key: rawKey,
        prefix: record.keyPrefix,
        name: record.name,
        createdAt: record.createdAt,
      });
    }
  );

  // GET /auth/keys — list API keys
  fastify.get(
    "/auth/keys",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const keys = await listApiKeys(userId);
      return reply.send({
        keys: keys.map((k) => ({
          id: k.id,
          prefix: k.keyPrefix,
          name: k.name,
          lastUsedAt: k.lastUsedAt,
          createdAt: k.createdAt,
        })),
      });
    }
  );

  // DELETE /auth/keys/:id — revoke API key
  fastify.delete<{ Params: KeyParams }>(
    "/auth/keys/:id",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const revoked = await revokeApiKey((request.params as KeyParams).id, userId);
      if (!revoked) {
        return reply.status(404).send({ error: "key not found or already revoked" });
      }
      return reply.status(204).send();
    }
  );

  // POST /auth/keys/:id/rotate — rotate API key
  fastify.post<{ Params: KeyParams }>(
    "/auth/keys/:id/rotate",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const result = await rotateApiKey((request.params as KeyParams).id, userId);
      if (!result) {
        return reply.status(404).send({ error: "key not found or already revoked" });
      }
      return reply.send({
        id: result.record.id,
        key: result.rawKey,
        prefix: result.record.keyPrefix,
        name: result.record.name,
        createdAt: result.record.createdAt,
      });
    }
  );

  // GET /usage — current billing period usage stats
  fastify.get(
    "/usage",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      const info = await getUsageInfo(userId);
      return reply.send({
        tier: info.tier,
        used: info.used,
        limit: info.limit,
        remaining: info.remaining,
        periodStart: info.periodStart,
        periodEnd: info.periodEnd,
      });
    }
  );
}
