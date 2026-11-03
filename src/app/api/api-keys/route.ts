import { NextResponse } from "next/server";
import { z } from "zod";
import { requireEditor } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import {
  ALLOWED_SCOPES,
  createApiKey,
  listApiKeys,
} from "@/lib/agent/apiKeys";
import { fail, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().min(2).max(100),
  // Must stay in step with the api_keys.assistant CHECK constraint.
  assistant: z.enum(["chatgpt", "claude", "deepseek", "hermes", "custom"]),
  scopes: z.array(z.enum(ALLOWED_SCOPES)).optional(),
});

export async function GET() {
  try {
    await requireEditor();
    return NextResponse.json({ ok: true, data: await listApiKeys() });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const user = await requireEditor();
    const input = schema.parse(await readJson(request));
    const created = await createApiKey({ ...input, userId: user.id });
    return NextResponse.json({ ok: true, data: created });
  } catch (error) {
    return fail(error);
  }
}
