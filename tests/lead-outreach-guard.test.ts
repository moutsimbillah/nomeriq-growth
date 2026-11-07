import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const transport = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/email/send-provider", async (original) => ({
  ...(await original<typeof import("@/lib/email/send-provider")>()),
  deliverEmail: async () => { transport.calls += 1; throw new Error("No transport allowed in tier guard tests"); },
}));
import { getDb, closeDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { assertLeadOutreachAllowed } from "@/lib/services/lead-outreach-guard";
import { getRecipientPolicy } from "@/lib/services/recipient-policy";
import { generateDraftForProspect, savePreparedFirstContactDraft } from "@/lib/services/drafts";
import { sendDraft } from "@/lib/services/email-sending";
import { sendReply } from "@/lib/services/conversations";
import { saveLeadAssessment } from "@/lib/services/lead-model";

const leads: string[] = [];
beforeAll(async () => {
  await ensureWorkspaceDefaults();
  const db = await getDb();
  // The exact approved additive SQL; useful while 030 is being prepared for the migration runner.
  await db.exec(readFileSync("docs/lead-model-migration-proposal.sql", "utf8"));
});
afterEach(() => expect(transport.calls).toBe(0));
afterAll(async () => {
  const db = await getDb();
  for (const table of ["outbound_sends", "messages", "conversations", "drafts", "prospect_assessment_overrides", "prospect_assessments", "prospect_emails"]) {
    await db.query(`DELETE FROM ${table} WHERE prospect_id = ANY($1::uuid[])`, [leads]);
  }
  await db.query("DELETE FROM prospects WHERE id=ANY($1::uuid[])", [leads]);
  await closeDb();
});
async function fixture(tier: "category_b" | "excluded" | null, queued = false) {
  const db = await getDb();
  const id = crypto.randomUUID(); leads.push(id);
  const email = `${id}@example.test`;
  await db.query(`INSERT INTO prospects (id,business_name,name_key,categories,qualification_status,status)
    VALUES ($1,$2,$2,'["forex"]','verified','verified')`, [id, `tier-guard-${id}`]);
  await db.query(`INSERT INTO prospect_emails (id,prospect_id,email,normalized_email,source_url)
    VALUES ($1,$2,$3,$3,'https://example.test/contact')`, [crypto.randomUUID(),id,email]);
  if (tier) await db.query(`INSERT INTO prospect_assessments
    (id,prospect_id,rules_version,assessed_at,source_kind,eligibility,tier,exclusion_reason,provenance_key)
    VALUES ($1,$2,'fixture',now(),'research',$3,$4,$5,$6)`,
    [crypto.randomUUID(),id,tier === "excluded" ? "excluded" : "eligible",tier,tier === "excluded" ? "Education only" : null,crypto.randomUUID()]);
  const draftId = crypto.randomUUID();
  await db.query(`INSERT INTO drafts (id,prospect_id,status,subject,body,recipient_email)
    VALUES ($1,$2,'approved','Signals question','A complete existing approved draft body.',$3)`, [draftId,id,email]);
  const conversationId = crypto.randomUUID();
  await db.query(`INSERT INTO conversations (id,prospect_id,subject) VALUES ($1,$2,'Existing thread')`, [conversationId,id]);
  if (queued) await db.query(`INSERT INTO outbound_sends (id,prospect_id,draft_id,idempotency_key,status)
    VALUES ($1,$2,$3,$4,'queued')`, [crypto.randomUUID(),id,draftId,crypto.randomUUID()]);
  return { id,email,draftId,conversationId };
}

it("Category B is refused at the final send gate even for old approved and queued drafts", async () => {
  const f = await fixture("category_b", true);
  await expect(sendDraft({ actorUserId: crypto.randomUUID(), draftId: f.draftId, allowFounderRecipient: true })).rejects.toMatchObject({ code: "alternative_contact_only" });
  const db = await getDb();
  expect((await db.query<{ status: string }>("SELECT status FROM outbound_sends WHERE draft_id=$1", [f.draftId])).rows[0].status).toBe("queued");
  expect((await getRecipientPolicy(f.id)).blocked).toBe(true);
});
it("a typed founder recipient cannot create an address to bypass Category B", async () => {
  const f = await fixture("category_b"); const db = await getDb();
  const typed = `${crypto.randomUUID()}@example.test`;
  await db.query("UPDATE drafts SET recipient_email=$2 WHERE id=$1", [f.draftId, typed]);
  await expect(sendDraft({ actorUserId: crypto.randomUUID(), draftId: f.draftId, allowFounderRecipient: true })).rejects.toMatchObject({ code: "alternative_contact_only" });
  expect((await db.query("SELECT id FROM prospect_emails WHERE normalized_email=$1", [typed])).rows).toHaveLength(0);
  expect((await db.query("SELECT id FROM outbound_sends WHERE prospect_id=$1", [f.id])).rows).toHaveLength(0);
});
it("Category B cannot generate or save a first-email draft or send a reply", async () => {
  const f = await fixture("category_b");
  await expect(generateDraftForProspect({ prospectId: f.id, actorType: "founder" })).rejects.toMatchObject({ code: "alternative_contact_only" });
  await expect(savePreparedFirstContactDraft({ prospectId: f.id, subject: "Question", body: "A complete source-backed message body", actorType: "api" })).rejects.toMatchObject({ code: "alternative_contact_only" });
  await expect(sendReply({ conversationId: f.conversationId, subject: "Re: question", body: "A reply", actorUserId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: "alternative_contact_only" });
});
it("Excluded cannot be emailed, while an existing unassessed lead is not silently demoted", async () => {
  const excluded = await fixture("excluded");
  await expect(sendDraft({ actorUserId: crypto.randomUUID(), draftId: excluded.draftId })).rejects.toMatchObject({ code: "excluded_lead" });
  const unassessed = await fixture(null);
  await expect(assertLeadOutreachAllowed(unassessed.id)).resolves.toBeUndefined();
  const db = await getDb();
  expect((await db.query("SELECT id FROM prospect_assessments WHERE prospect_id=$1", [unassessed.id])).rows).toHaveLength(0);
});
it("an incomplete new assessment cannot bypass qualification through an old approved draft", async () => {
  const f = await fixture(null);
  await saveLeadAssessment(f.id, { assessedAt: new Date().toISOString(), sourceKind: "research", provenanceKey: crypto.randomUUID() });
  await expect(sendDraft({ actorUserId: crypto.randomUUID(), draftId: f.draftId })).rejects.toMatchObject({ code: "unqualified_lead" });
});
