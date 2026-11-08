import { getDb } from "@/lib/db/client";
import { AppError, asStringArray, iso, json, number } from "@/lib/utils";
import type { ProductTruth } from "@/lib/types";
import { DEFAULT_TIMEZONE, isValidTimezone } from "@/lib/dates/timezone";
import { mapProductTruth } from "./mappers";

export interface WorkspaceSettings {
  legalBusinessName: string;
  postalAddress: string;
  postalAddressEnabled: boolean;
  senderSignature: string;
  senderSignatureEnabled: boolean;
  footerNote: string;
  followUpMax: number;
  followUpAutoEnabled: boolean;
  followUpDailyLimit: number;
  followUpDelay1Days: number;
  followUpDelay2Days: number;
  syncStaleHours: number;
  timezone: string;
  researchDefaultBudgetUsd: number;
  researchDefaultConcurrency: number;
  deepseekSearchQps: number;
  deepseekFetchQps: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

export async function ensureWorkspaceDefaults(): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO workspace_settings (id) VALUES ('default')
     ON CONFLICT (id) DO NOTHING`,
  );
  const truth = await db.query("SELECT id FROM product_truth LIMIT 1");
  if (truth.rows.length === 0) {
    await db.query(
      `INSERT INTO product_truth
        (id, version, status, one_liner, offer_summary, how_it_works, pricing_notes,
         integrations, limitations, approved_claims, prohibited_claims)
       VALUES ($1, 1, 'needs_review', $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
      [
        crypto.randomUUID(),
        "Nomeriq is a white-label SaaS platform for businesses that sell trading signals.",
        "Nomeriq builds a white-label SaaS platform for businesses that sell trading signals. The founder has not yet approved a detailed feature list for outreach.",
        "Founder input needed. Do not make claims about implementation or workflow automation.",
        "No pricing is approved for outreach. Do not quote a price, discount, or commercial term.",
        "Founder input needed. Do not claim any integration.",
        "Do not claim trading performance, win rates, client results, guarantees, or capabilities not listed in the approved claims.",
        JSON.stringify([
          "Nomeriq is a white-label SaaS platform for businesses that sell trading signals.",
        ]),
        JSON.stringify([
          "guaranteed results",
          "trading performance",
          "win rate",
          "risk-free",
          "specific pricing",
          "unapproved integrations",
          "client case studies",
        ]),
      ],
    );
  }
}

export async function getWorkspaceSettings(): Promise<WorkspaceSettings> {
  await ensureWorkspaceDefaults();
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT * FROM workspace_settings WHERE id = 'default'`,
  );
  const row = result.rows[0];
  return {
    legalBusinessName: row.legal_business_name,
    postalAddress: row.postal_address,
    postalAddressEnabled: row.postal_address_enabled !== false,
    senderSignature: row.sender_signature,
    senderSignatureEnabled: row.sender_signature_enabled !== false,
    footerNote: row.footer_note,
    followUpMax: number(row.follow_up_max, 2),
    followUpAutoEnabled: row.follow_up_auto_enabled === true,
    followUpDailyLimit: number(row.follow_up_daily_limit, 10),
    followUpDelay1Days: number(row.follow_up_delay_1_days, 4),
    followUpDelay2Days: number(row.follow_up_delay_2_days, 7),
    syncStaleHours: number(row.sync_stale_hours, 24),
    timezone: isValidTimezone(row.timezone) ? row.timezone : DEFAULT_TIMEZONE,
    researchDefaultBudgetUsd: number(row.research_default_budget_usd, 5),
    researchDefaultConcurrency: number(row.research_default_concurrency, 1),
    deepseekSearchQps: number(row.deepseek_search_qps, 2),
    deepseekFetchQps: number(row.deepseek_fetch_qps, 1),
  };
}

export async function updateWorkspaceSettings(
  input: Partial<WorkspaceSettings>,
  userId: string,
): Promise<WorkspaceSettings> {
  if (input.timezone !== undefined && !isValidTimezone(input.timezone)) {
    throw new AppError(
      "Choose a valid IANA timezone.",
      400,
      "invalid_timezone",
    );
  }
  await ensureWorkspaceDefaults();
  const current = await getWorkspaceSettings();
  const next = { ...current, ...input };

  if (!next.legalBusinessName.trim()) {
    throw new AppError("A truthful sender name is required.");
  }
  if (next.followUpMax < 0 || next.followUpMax > 3) {
    throw new AppError("Follow-ups must be between 0 and 3.");
  }
  if (
    !Number.isInteger(next.followUpDailyLimit) ||
    next.followUpDailyLimit < 0 ||
    next.followUpDailyLimit > 50
  ) {
    throw new AppError("Automatic follow-ups must be between 0 and 50 a day.");
  }
  if (next.followUpDelay1Days < 1 || next.followUpDelay2Days < 1) {
    throw new AppError("Follow-up delays must be at least one day.");
  }
  // DeepSeek's documented ceiling is 5 requests/second per account for both
  // Search and Fetch. Validating here (rather than only at the CHECK constraint)
  // turns an oversized value into a clear 400 instead of a raw database error.
  if (
    !Number.isInteger(next.deepseekSearchQps) ||
    next.deepseekSearchQps < 1 ||
    next.deepseekSearchQps > 5
  ) {
    throw new AppError(
      "DeepSeek allows at most 5 requests per second. Search QPS must be a whole number between 1 and 5.",
    );
  }
  if (
    !Number.isInteger(next.deepseekFetchQps) ||
    next.deepseekFetchQps < 1 ||
    next.deepseekFetchQps > 5
  ) {
    throw new AppError(
      "DeepSeek allows at most 5 requests per second. Fetch QPS must be a whole number between 1 and 5.",
    );
  }

  const db = await getDb();
  await db.query(
    `UPDATE workspace_settings SET
       legal_business_name = $1,
       postal_address = $2,
       sender_signature = $3,
       footer_note = $4,
       follow_up_max = $5,
       follow_up_auto_enabled = $15,
       follow_up_daily_limit = $16,
       follow_up_delay_1_days = $6,
       follow_up_delay_2_days = $7,
       sync_stale_hours = $8,
       timezone = $9,
       research_default_budget_usd = $10,
       research_default_concurrency = $11,
       deepseek_search_qps = $12,
       deepseek_fetch_qps = $13,
       sender_signature_enabled = $17,
       postal_address_enabled = $18,
       updated_by = $14,
       updated_at = now()
     WHERE id = 'default'`,
    [
      next.legalBusinessName.trim(),
      next.postalAddress.trim(),
      next.senderSignature.trim(),
      next.footerNote.trim(),
      next.followUpMax,
      next.followUpDelay1Days,
      next.followUpDelay2Days,
      next.syncStaleHours,
      next.timezone,
      next.researchDefaultBudgetUsd,
      next.researchDefaultConcurrency,
      next.deepseekSearchQps,
      next.deepseekFetchQps,
      userId,
      next.followUpAutoEnabled,
      next.followUpDailyLimit,
      next.senderSignatureEnabled,
      next.postalAddressEnabled,
    ],
  );
  return getWorkspaceSettings();
}

export async function getProductTruth(): Promise<ProductTruth> {
  await ensureWorkspaceDefaults();
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT * FROM product_truth ORDER BY version DESC LIMIT 1`,
  );
  if (!result.rows[0]) {
    throw new AppError("Product Truth is not initialized.", 500);
  }
  return mapProductTruth(result.rows[0]);
}

export interface ProductTruthInput {
  oneLiner: string;
  offerSummary: string;
  howItWorks: string;
  pricingNotes: string;
  integrations: string;
  limitations: string;
  approvedClaims: string[];
  prohibitedClaims: string[];
  /** Omitted by older clients: the current questions are kept. */
  discoveryQuestions?: string[];
  approve: boolean;
}

export async function saveProductTruth(
  input: ProductTruthInput,
  userId: string,
): Promise<ProductTruth> {
  await ensureWorkspaceDefaults();
  if (!input.oneLiner.trim()) {
    throw new AppError("The one-line description is required.");
  }
  if (input.approve && !input.approvedClaims.some((claim) => claim.trim())) {
    throw new AppError(
      "Add at least one explicit approved claim before approving Product Truth.",
    );
  }
  const db = await getDb();
  const current = await getProductTruth();

  await db.transaction(async (tx) => {
    const updated = await tx.query<any>(
      `UPDATE product_truth SET
        version = version + 1,
        status = $1,
        one_liner = $2,
        offer_summary = $3,
        how_it_works = $4,
        pricing_notes = $5,
        integrations = $6,
        limitations = $7,
        approved_claims = $8::jsonb,
        prohibited_claims = $9::jsonb,
        discovery_questions = $13::jsonb,
        approved_by = $10,
        approved_at = $11,
        updated_by = $10,
        updated_at = now()
       WHERE id = $12
       RETURNING *`,
      [
        input.approve ? "approved" : "needs_review",
        input.oneLiner.trim(),
        input.offerSummary.trim(),
        input.howItWorks.trim(),
        input.pricingNotes.trim(),
        input.integrations.trim(),
        input.limitations.trim(),
        JSON.stringify(input.approvedClaims.filter((claim) => claim.trim())),
        JSON.stringify(input.prohibitedClaims.filter((claim) => claim.trim())),
        userId,
        input.approve ? new Date().toISOString() : null,
        current.id,
        JSON.stringify((input.discoveryQuestions ?? current.discoveryQuestions).map((question) => question.trim()).filter(Boolean)),
      ],
    );
    const row = updated.rows[0];
    await tx.query(
      `INSERT INTO product_truth_revisions
        (id, product_truth_id, version, snapshot, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        crypto.randomUUID(),
        current.id,
        row.version,
        JSON.stringify({
          status: row.status,
          oneLiner: row.one_liner,
          offerSummary: row.offer_summary,
          howItWorks: row.how_it_works,
          pricingNotes: row.pricing_notes,
          integrations: row.integrations,
          limitations: row.limitations,
          approvedClaims: asStringArray(row.approved_claims),
          prohibitedClaims: asStringArray(row.prohibited_claims),
          discoveryQuestions: asStringArray(row.discovery_questions),
        }),
        userId,
      ],
    );
  });

  return getProductTruth();
}

export async function listProductTruthRevisions(): Promise<
  {
    id: string;
    version: number;
    createdAt: string;
    status: string;
    snapshot: Record<string, unknown>;
    authorName: string | null;
  }[]
> {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT r.id, r.version, r.created_at, r.snapshot, u.name AS author_name
     FROM product_truth_revisions r
     LEFT JOIN users u ON u.id = r.created_by
     ORDER BY r.created_at DESC LIMIT 20`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    version: number(row.version),
    createdAt: iso(row.created_at) ?? "",
    status: String(json<Record<string, unknown>>(row.snapshot, {}).status ?? ""),
    snapshot: json<Record<string, unknown>>(row.snapshot, {}),
    authorName: row.author_name,
  }));
}

export async function listUsers() {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT id, email, name, role, is_active, created_at, last_login_at
     FROM users ORDER BY created_at ASC`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    isActive: Boolean(row.is_active),
    createdAt: iso(row.created_at),
    lastLoginAt: iso(row.last_login_at),
  }));
}
