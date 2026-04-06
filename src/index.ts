import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { extractRoutes } from "./routes/extract.js";

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

  await fastify.register(extractRoutes);

  return fastify;
}

async function start() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY environment variable is required");
    process.exit(1);
  }

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
