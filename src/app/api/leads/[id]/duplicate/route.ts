import { NextResponse } from "next/server";
import { z } from "zod";

import { fail, readJson } from "@/lib/api";
import { assertSameOrigin } from "@/lib/auth/request";
import { requireFounder } from "@/lib/auth/session";
import {
  getActiveDuplicateLink,
  listDuplicatesOf,
  markProspectDuplicate,
  restoreProspectDuplicate,
  searchCanonicalCandidates,
} from "@/lib/services/prospect-duplicates";
import { AppError } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Founder-only "Duplicate of" control for one lead.
 *
 * GET  ?q=…                      — the lead's current duplicate link, leads marked as duplicates of it,
 *                                  and (with q) active leads it could be a duplicate of.
 * POST {action:"mark", canonicalProspectId, confirm:true} — archive + link, reversible.
 * POST {action:"restore"}         — put the lead back, only if nothing changed since the mark.
 *
 * Never exposed as an agent/MCP tool (AGENTS.md rule 5). Input is strictly validated: unknown fields,
 * arrays, scalars or a missing confirmation are refused before the service is called.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const prospectId = z.string().regex(UUID, "A valid lead id is required.");

const bodySchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("mark"),
      canonicalProspectId: prospectId,
      confirm: z.literal(true, { message: "Confirm the duplicate warning first." }),
    })
    .strict(),
  z.object({ action: z.literal("restore") }).strict(),
]);

const querySchema = z.object({ q: z.string().max(100).optional() }).strict();

async function leadId(context: { params: Promise<{ id: string }> }): Promise<string> {
  const { id } = await context.params;
  if (!UUID.test(id)) throw new AppError("Lead not found.", 404, "prospect_not_found");
  return id;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireFounder();
    const id = await leadId(context);
    const params = querySchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const [link, duplicates, candidates] = await Promise.all([
      getActiveDuplicateLink(id),
      listDuplicatesOf(id),
      params.q ? searchCanonicalCandidates(id, params.q) : Promise.resolve([]),
    ]);
    return NextResponse.json(
      { ok: true, data: { link, duplicates, candidates } },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const user = await requireFounder();
    const id = await leadId(context);
    const raw = await readJson<unknown>(request);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new AppError("Request body must be a JSON object.", 400, "invalid_body");
    }
    const input = bodySchema.parse(raw);
    if (input.action === "mark") {
      const result = await markProspectDuplicate({
        prospectId: id,
        canonicalProspectId: input.canonicalProspectId,
        actor: user,
      });
      return NextResponse.json({ ok: true, data: result });
    }
    const result = await restoreProspectDuplicate({ prospectId: id, actor: user });
    return NextResponse.json({ ok: true, data: result });
  } catch (error) {
    return fail(error);
  }
}
