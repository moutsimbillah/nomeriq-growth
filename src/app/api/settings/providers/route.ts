import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { listResearchProviders } from "@/lib/deepseek/provider-pool";
import { createResearchProvider } from "@/lib/services/research-provider-admin";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  provider: z.string().min(1).max(50).optional(),
  kinds: z.string().min(1).max(20).optional(),
  apiKey: z.string().min(1).max(500),
  baseUrl: z.string().max(500).optional(),
  model: z.string().max(300).optional(),
  searchPath: z.string().max(300).nullable().optional(),
  fetchPath: z.string().max(300).nullable().optional(),
  priority: z.number().int().min(1).max(1000).optional(),
  isEnabled: z.boolean().optional(),
});

/** The ordered list of providers the engine and the AI actions will try. */
export async function GET() {
  try {
    await requireEditor();
    return NextResponse.json({
      ok: true,
      data: { providers: await listResearchProviders() },
    });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const input = createSchema.parse(await readJson(request));

    const id = await createResearchProvider({ ...input, createdBy: user.id });

    return NextResponse.json(
      { ok: true, data: { id, providers: await listResearchProviders() } },
      { status: 201 },
    );
  } catch (error) {
    return fail(error);
  }
}