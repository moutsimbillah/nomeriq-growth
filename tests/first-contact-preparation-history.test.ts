import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as writer from "@/lib/ai/writer";

import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { generateDraftForProspect, getFirstContactDraft, savePreparedFirstContactDraft } from "@/lib/services/drafts";
import { priorContactExists } from "@/lib/services/prior-contact";
import { saveProspect } from "@/lib/services/prospects";
import { assessmentFor } from "./helpers/lead-assessment";

const leads: string[] = [];
const detachedMessageIds: string[] = [];

async function lead(label: string) {
  const domain = `${crypto.randomUUID()}.${label}.example.test`;
  const email = `owner@${domain}`;
  const saved = await saveProspect({
    businessName: `First contact history ${label}`,
    websiteUrl: `https://${domain}`,
    categories: ["forex"],
    signalDescription: "A paid trading signal business with a published contact address.",
    email,
    emailSourceType: "official_website",
    emailSourceUrl: `https://${domain}/contact`,
    sources: [{ url: `https://${domain}/pricing`, label: "Synthetic pricing" }],
    leadAssessment: assessmentFor(`https://${domain}`),
    evidenceSummary: "Synthetic source-backed fixture.",
    actorType: "seed",
  });
  leads.push(saved.prospect.id);
  return { id: saved.prospect.id, email };
}

async function draftFor(prospectId: string, email: string) {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
      ai_generated, warnings, created_by_type)
     VALUES ($1, $2, 'first_contact', 0, 'draft', 'Existing question',
       'An existing first-contact body long enough for the fixture.', $3, false, '[]'::jsonb, 'seed')`,
    [id, prospectId, email],
  );
  return id;
}

async function contactedByMessage(prospectId: string, email: string) {
  const db = await getDb();
  const messageId = crypto.randomUUID();
  await db.query(
    `INSERT INTO messages (id, prospect_id, direction, from_email, to_emails, subject, body_text,
      delivery_status, sent_at)
     VALUES ($1, $2, 'outbound', 'sender@example.test', $3::jsonb, 'Earlier message', 'Earlier body',
       'accepted', now())`,
    [messageId, prospectId, JSON.stringify([email])],
  );
}

async function contactedBySend(prospectId: string, email: string, status: "accepted" | "sandbox" | "uncertain") {
  const db = await getDb();
  const draftId = await draftFor(prospectId, email);
  await db.query(
    `INSERT INTO outbound_sends (id, draft_id, prospect_id, recipient_email, idempotency_key, status, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [crypto.randomUUID(), draftId, prospectId, email, crypto.randomUUID(), status],
  );
}

async function expectRefusal(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({ code: "already_contacted" });
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
});

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  const db = await getDb();
  if (leads.length) {
    await db.query("DELETE FROM prospect_duplicate_links WHERE prospect_id=ANY($1::uuid[]) OR canonical_prospect_id=ANY($1::uuid[])", [leads]);
    await db.query("DELETE FROM outbound_sends WHERE prospect_id=ANY($1::uuid[])", [leads]);
    await db.query("DELETE FROM messages WHERE prospect_id=ANY($1::uuid[])", [leads]);
    if (detachedMessageIds.length) await db.query("DELETE FROM messages WHERE id=ANY($1::uuid[])", [detachedMessageIds]);
    await db.query("DELETE FROM prospect_assessment_overrides WHERE prospect_id=ANY($1::uuid[])", [leads]);
    await db.query("DELETE FROM prospect_assessments WHERE prospect_id=ANY($1::uuid[])", [leads]);
    await db.query("DELETE FROM drafts WHERE prospect_id=ANY($1::uuid[])", [leads]);
    await db.query("DELETE FROM prospect_emails WHERE prospect_id=ANY($1::uuid[])", [leads]);
    await db.query("DELETE FROM prospect_sources WHERE prospect_id=ANY($1::uuid[])", [leads]);
    await db.query("DELETE FROM prospects WHERE id=ANY($1::uuid[])", [leads]);
  }
  await closeDb();
});

describe("first-contact preparation uses the shared contact history", () => {
  it("recognizes direct outbound messages and accepted, sandbox, and uncertain sends", async () => {
    const direct = await lead("direct");
    await contactedByMessage(direct.id, direct.email);
    expect(await priorContactExists(direct.id)).toBe(true);

    for (const status of ["accepted", "sandbox", "uncertain"] as const) {
      const sent = await lead(status);
      await contactedBySend(sent.id, sent.email, status);
      expect(await priorContactExists(sent.id)).toBe(true);
      await expectRefusal(generateDraftForProspect({ prospectId: sent.id, actorType: "founder", force: true }));
    }
  });

  it("recognizes a prior message addressed to the contacted recipient address", async () => {
    const recipient = await lead("recipient");
    const db = await getDb();
    await db.query(
      `INSERT INTO messages (id, direction, from_email, to_emails, subject, body_text, delivery_status, sent_at)
       VALUES ($1, 'outbound', 'sender@example.test', $2::jsonb, 'Earlier message', 'Earlier body', 'accepted', now())`,
      [(() => { const id = crypto.randomUUID(); detachedMessageIds.push(id); return id; })(), JSON.stringify([` ${recipient.email.toUpperCase()} `])],
    );
    expect(await priorContactExists(recipient.id)).toBe(true);
  });

  it("follows an active linked duplicate into the canonical lead", async () => {
    const canonical = await lead("canonical");
    const duplicate = await lead("duplicate");
    const db = await getDb();
    await db.query(
      `INSERT INTO prospect_duplicate_links (id, prospect_id, canonical_prospect_id, previous_state)
       VALUES ($1, $2, $3, '{}'::jsonb)`,
      [crypto.randomUUID(), duplicate.id, canonical.id],
    );
    await contactedByMessage(duplicate.id, duplicate.email);
    expect(await priorContactExists(canonical.id)).toBe(true);
  });

  it("refuses new preparation without creating a draft, but preserves a non-force saved draft read", async () => {
    const generate = vi.spyOn(writer, "generateFirstContact").mockImplementation(async () => {
      throw new Error("No model call is allowed for a contacted lead.");
    });
    const contacted = await lead("guard");
    const before = await getDb();
    const countBefore = await before.query("SELECT count(*)::int AS n FROM drafts WHERE prospect_id=$1", [contacted.id]);
    await contactedByMessage(contacted.id, contacted.email);

    await expectRefusal(savePreparedFirstContactDraft({
      prospectId: contacted.id,
      subject: "A question about your signal service",
      body: "I noticed your signal service and wanted to ask how subscribers access it today.",
      actorType: "api",
    }));
    await expectRefusal(generateDraftForProspect({ prospectId: contacted.id, actorType: "founder", force: true }));
    expect(generate).not.toHaveBeenCalled();
    const countAfter = await before.query("SELECT count(*)::int AS n FROM drafts WHERE prospect_id=$1", [contacted.id]);
    expect(countAfter.rows[0].n).toBe(countBefore.rows[0].n);

    const existing = await draftFor(contacted.id, contacted.email);
    const preserved = await generateDraftForProspect({ prospectId: contacted.id, actorType: "founder" });
    expect(preserved.id).toBe(existing);
    expect((await getFirstContactDraft(contacted.id))?.id).toBe(existing);
  });

  it("refuses preparation from conversation-only outbound history", async () => {
    const contacted = await lead("conversation-only");
    const db = await getDb();
    const conversationId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    detachedMessageIds.push(messageId);
    await db.query(`INSERT INTO conversations(id,prospect_id,subject) VALUES($1,$2,'Synthetic thread')`, [conversationId, contacted.id]);
    await db.query(`INSERT INTO messages(id,conversation_id,direction,from_email,to_emails,body_text,delivery_status,sent_at)
      VALUES($1,$2,'outbound','sender@example.test','[]'::jsonb,'Earlier synthetic message','accepted',now())`, [messageId, conversationId]);
    await expectRefusal(generateDraftForProspect({ prospectId: contacted.id, actorType: "founder" }));
    expect(await getFirstContactDraft(contacted.id)).toBeNull();
  });

  it("keeps the fresh save path working for a never-contacted lead", async () => {
    const fresh = await lead("fresh");
    const result = await savePreparedFirstContactDraft({
      prospectId: fresh.id,
      subject: "A question about your signal service",
      body: "I noticed your signal service and wanted to ask how subscribers access it today.",
      actorType: "api",
    });
    expect(result.preserved).toBe(false);
    expect(result.draft.kind).toBe("first_contact");
    expect(await priorContactExists(fresh.id)).toBe(false);
  });
});
