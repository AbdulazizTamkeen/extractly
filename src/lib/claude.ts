import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export type SupportedMediaType =
  | "application/pdf"
  | "image/jpeg"
  | "image/png"
  | "image/gif"
  | "image/webp";

const IMAGE_MEDIA_TYPES: SupportedMediaType[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

const SUPPORTED_MEDIA_TYPES: SupportedMediaType[] = [
  "application/pdf",
  ...IMAGE_MEDIA_TYPES,
];

export function isSupportedMediaType(
  mediaType: string
): mediaType is SupportedMediaType {
  return SUPPORTED_MEDIA_TYPES.includes(mediaType as SupportedMediaType);
}

export async function extractFromDocument(
  fileBuffer: Buffer,
  mediaType: SupportedMediaType,
  schema: Record<string, unknown>,
  htmlContent?: string
): Promise<Record<string, unknown>> {
  const schemaStr = JSON.stringify(schema, null, 2);

  const systemPrompt = `You are a precise data extraction assistant. Extract structured data from the provided document exactly matching the JSON schema provided. Return ONLY valid JSON with no additional text, markdown, or explanation. The JSON must conform exactly to the given schema structure.`;

  let messages: Anthropic.MessageParam[];

  if (htmlContent) {
    // HTML content passed as text
    messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Extract structured data from this HTML document according to the following JSON schema:\n\n${schemaStr}\n\nHTML content:\n\n${htmlContent}\n\nReturn ONLY the extracted JSON object.`,
          },
        ],
      },
    ];
  } else if (mediaType === "application/pdf") {
    messages = [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: fileBuffer.toString("base64"),
            },
          },
          {
            type: "text",
            text: `Extract structured data from the document above according to the following JSON schema:\n\n${schemaStr}\n\nReturn ONLY the extracted JSON object.`,
          },
        ],
      },
    ];
  } else {
    // Image type
    const imageMediaType = mediaType as
      | "image/jpeg"
      | "image/png"
      | "image/gif"
      | "image/webp";
    messages = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: imageMediaType,
              data: fileBuffer.toString("base64"),
            },
          },
          {
            type: "text",
            text: `Extract structured data from this image according to the following JSON schema:\n\n${schemaStr}\n\nReturn ONLY the extracted JSON object.`,
          },
        ],
      },
    ];
  }

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  });

  const content = response.content[0];
  if (content.type !== "text") {
    throw new Error("Unexpected response type from Claude API");
  }

  // Strip markdown code fences if present
  let jsonText = content.text.trim();
  if (jsonText.startsWith("```")) {
    jsonText = jsonText
      .replace(/^```(?:json)?\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
  }

  const extracted = JSON.parse(jsonText);
  return extracted;
}
