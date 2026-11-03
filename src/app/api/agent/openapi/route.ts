import { NextResponse } from "next/server";
import { TOOL_DEFINITIONS } from "@/lib/agent/service";
import { corsHeaders, preflight } from "@/lib/api/cors";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const base = (process.env.APP_URL || "http://localhost:3100").replace(/\/$/, "");
  const paths: Record<string, unknown> = {};
  for (const tool of TOOL_DEFINITIONS) {
    paths[`/api/agent/v1/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.name.replace(/_/g, " "),
        description: tool.description,
        security: [{ bearerAuth: [] }],
        "x-openai-isConsequential": ["save_prospect", "save_draft"].includes(
          tool.name,
        ),
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: tool.inputSchema,
            },
          },
        },
        responses: {
          "200": {
            description: "Growth response",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ok: { type: "boolean" },
                    data: { type: "object", additionalProperties: true },
                  },
                },
              },
            },
          },
          "401": { description: "Missing or invalid API key" },
          "403": { description: "Insufficient scope" },
          "409": { description: "Duplicate or business-rule rejection" },
        },
      },
    };
  }

  return NextResponse.json(
    {
      openapi: "3.1.0",
      info: {
        title: "Nomeriq Growth Agent API",
        version: "1.0.0",
        description:
          "Authorized API for ChatGPT and Claude to research verified trading-signal providers, check duplicates, save prospects with public contact emails and save drafts. It has no send, delete, permission, Product Truth mutation, or settings tools. Read get_instructions first.",
      },
      servers: [{ url: base }],
      paths,
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            description:
              "A Nomeriq Growth API key created in Settings → AI integrations.",
          },
        },
      },
    },
    {
      headers: {
        "Cache-Control": "public, max-age=60",
        ...corsHeaders(request),
      },
    },
  );
}

export async function OPTIONS(request: Request) {
  return preflight(request);
}
