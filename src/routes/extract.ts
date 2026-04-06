import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { MultipartFile } from "@fastify/multipart";
import { extractFromDocument, isSupportedMediaType } from "../lib/claude.js";

const SUPPORTED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "text/html",
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

interface ExtractBody {
  schema?: string;
}

export async function extractRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/extract",
    {
      schema: {
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: { type: "object" },
              metadata: {
                type: "object",
                properties: {
                  filename: { type: "string" },
                  mediaType: { type: "string" },
                  fileSize: { type: "number" },
                },
              },
            },
          },
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parts = request.parts();

      let fileBuffer: Buffer | null = null;
      let mediaType: string | null = null;
      let filename: string | null = null;
      let schemaObj: Record<string, unknown> | null = null;
      let htmlContent: string | null = null;

      for await (const part of parts) {
        if (part.type === "file") {
          const filePart = part as MultipartFile;
          filename = filePart.filename;
          mediaType = filePart.mimetype;

          const chunks: Buffer[] = [];
          let totalSize = 0;

          for await (const chunk of filePart.file) {
            totalSize += chunk.length;
            if (totalSize > MAX_FILE_SIZE) {
              return reply.status(413).send({
                success: false,
                error: "File too large. Maximum size is 10MB.",
              });
            }
            chunks.push(chunk as Buffer);
          }

          fileBuffer = Buffer.concat(chunks);

          if (mediaType === "text/html") {
            htmlContent = fileBuffer.toString("utf-8");
          }
        } else if (part.type === "field" && part.fieldname === "schema") {
          try {
            schemaObj = JSON.parse(part.value as string);
          } catch {
            return reply.status(400).send({
              success: false,
              error: "Invalid JSON in 'schema' field.",
            });
          }
        }
      }

      if (!fileBuffer || !mediaType) {
        return reply.status(400).send({
          success: false,
          error:
            "Missing file. Send a multipart/form-data request with a 'file' field.",
        });
      }

      if (!schemaObj) {
        return reply.status(400).send({
          success: false,
          error:
            "Missing 'schema' field. Send a JSON schema definition as a form field.",
        });
      }

      if (!SUPPORTED_MIME_TYPES.includes(mediaType)) {
        return reply.status(415).send({
          success: false,
          error: `Unsupported media type '${mediaType}'. Supported types: ${SUPPORTED_MIME_TYPES.join(", ")}.`,
        });
      }

      // For HTML, pass as text; otherwise need supported binary type
      if (mediaType !== "text/html" && !isSupportedMediaType(mediaType)) {
        return reply.status(415).send({
          success: false,
          error: `Unsupported media type '${mediaType}'.`,
        });
      }

      try {
        const extracted = await extractFromDocument(
          fileBuffer,
          isSupportedMediaType(mediaType) ? mediaType : "application/pdf",
          schemaObj,
          htmlContent ?? undefined
        );

        const usage = request.usageInfo;
        if (usage) {
          reply.header(
            "X-RateLimit-Limit",
            usage.limit === null ? "unlimited" : String(usage.limit)
          );
          reply.header(
            "X-RateLimit-Remaining",
            usage.remaining === null ? "unlimited" : String(usage.remaining)
          );
          reply.header("X-RateLimit-Used", String(usage.used));
          reply.header("X-RateLimit-Reset", usage.periodEnd);
        }

        // Upgrade CTA when user is at or above 80% of their limit
        const nearLimit =
          usage &&
          usage.limit !== null &&
          usage.remaining !== null &&
          usage.remaining <= Math.ceil(usage.limit * 0.2);

        return reply.status(200).send({
          success: true,
          data: extracted,
          metadata: {
            filename: filename ?? "unknown",
            mediaType,
            fileSize: fileBuffer.length,
          },
          ...(nearLimit
            ? {
                upgradeCta: {
                  message: `You have used ${usage!.used} of ${usage!.limit} extractions this month. Upgrade your plan for more.`,
                  upgradeUrl: "/billing/checkout",
                },
              }
            : {}),
        });
      } catch (err: unknown) {
        const error = err as Error;

        if (error.message?.includes("JSON")) {
          return reply.status(422).send({
            success: false,
            error: "Extraction succeeded but Claude returned non-JSON output.",
            detail: error.message,
          });
        }

        fastify.log.error(err);
        return reply.status(500).send({
          success: false,
          error: "Extraction failed. Please try again.",
          detail:
            process.env.NODE_ENV === "development" ? error.message : undefined,
        });
      }
    }
  );

  // Health check
  fastify.get("/health", async (_request, reply) => {
    return reply.send({ status: "ok", service: "extractly" });
  });
}
