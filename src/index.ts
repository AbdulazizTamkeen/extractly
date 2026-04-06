import Fastify from "fastify";
import multipart from "@fastify/multipart";
import fastifyJwt from "@fastify/jwt";
import { extractRoutes } from "./routes/extract.js";
import { authRoutes } from "./routes/auth.js";
import { billingRoutes } from "./routes/billing.js";
import { apiKeyMiddleware } from "./middleware/apiKey.js";
import { runMigrations } from "./lib/db.js";

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
    },
  });

  await fastify.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024, // 10MB
      files: 1,
    },
  });

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("JWT_SECRET environment variable is required");
  }
  await fastify.register(fastifyJwt, { secret: jwtSecret });

  // Decorator used by auth routes for JWT-protected endpoints
  fastify.decorate(
    "authenticate",
    async (request: Parameters<typeof fastify.authenticate>[0], reply: Parameters<typeof fastify.authenticate>[1]) => {
      try {
        await request.jwtVerify();
      } catch {
        return reply.status(401).send({ error: "Unauthorized" });
      }
    }
  );

  // Raw body parser for Stripe webhook signature verification
  fastify.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      (req as typeof req & { rawBody: Buffer }).rawBody = body as Buffer;
      try {
        done(null, JSON.parse((body as Buffer).toString()));
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  await fastify.register(authRoutes);
  await fastify.register(billingRoutes);

  // /extract is protected by API key
  await fastify.register(async (instance) => {
    instance.addHook("preHandler", apiKeyMiddleware);
    await instance.register(extractRoutes);
  });

  return fastify;
}

async function start() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY environment variable is required");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL environment variable is required");
    process.exit(1);
  }
  if (!process.env.JWT_SECRET) {
    console.error("JWT_SECRET environment variable is required");
    process.exit(1);
  }

  await runMigrations();

  const fastify = await buildServer();

  try {
    await fastify.listen({ port: PORT, host: HOST });
    console.log(`Extractly API running at http://${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
