import { getDb, type DbClient } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import { tagsFromActorType } from "@/lib/agent/agentTag";
import {
  addedWindow,
  COUNTED_ADDED_RANGES,
  parsePktDate,
  type AddedRange,
} from "@/lib/dates/pakistan";
import {
  AppError,
  asStringArray,
  domainFromUrl,
  isEmail,
  isGenericBusinessEmail,
  iso,
  normalizeEmail,
  normalizeHandle,
  normalizeName,
  normalizeWebsiteUrl,
  number,
} from "@/lib/utils";
import type {
  AgentTag,
  Category,
  ChannelTag,
  PipelineStatus,
  ProspectDetail,
  ProspectSummary,
} from "@/lib/types";
import { mapEmail, mapProspect, mapProspectDetail, mapSource } from "./mappers";
import { newestMessageFirst } from "./message-order";
import { leadModelConditions, leadPriorityOrderSql } from "@/lib/leads/query";
import type { LeadFilters } from "@/lib/leads/leadFilters";
import { leadIntakeSchema, type LeadIntake } from "@/lib/leads/intake";
import type { LeadModel } from "@/lib/leads/model";
import { isQualifiedTargetModel } from "@/lib/leads/qualified-target";
import { getLeadModel, saveLeadAssessment, saveAudienceObservation, saveContactRoute } from "./lead-model";
import { businessDomain, sharedProfileKey, socialKeys as identitySocialKeys, type SocialIdentity } from "@/lib/leads/identity";
import { refreshResearchJobStatus } from "./research";
import { getWorkspaceSettings } from "./settings";

/* eslint-disable @typescript-eslint/no-explicit-any */

const PROSPECT_SELECT = `
  SELECT p.*,
    (SELECT pe.email FROM prospect_emails pe
      WHERE pe.prospect_id = p.id
      ORDER BY pe.is_primary DESC, pe.verified_at ASC LIMIT 1) AS contact_email,
    (SELECT pe.source_url FROM prospect_emails pe
      WHERE pe.prospect_id = p.id
      ORDER BY pe.is_primary DESC, pe.verified_at ASC LIMIT 1) AS contact_email_source,
    (SELECT d.source_agent FROM drafts d
      WHERE d.prospect_id = p.id AND d.kind = 'first_contact' LIMIT 1) AS first_draft_agent
  FROM prospects p
`;

export interface DuplicateMatch {
  prospect: ProspectSummary;
  reasons: string[];
}

/**
 * Internal-only resolver options; deliberately NOT part of the identity input, so no MCP/REST/user
 * payload can reach them. `ignoreTarget` is the id of an EXISTING lead being written: matches that
 * belong to that lead's own founder-linked duplicate family are not conflicts. New saves never pass
 * it and keep full protection. Matches are always reported as their canonical (kept) lead.
 */
interface DuplicateCheckOptions {
  ignoreTarget?: string;
}

export async function checkDuplicate(input: {
  businessName?: string | null;
  websiteUrl?: string | null;
  emails?: string[];
  aliases?: string[];
  instagramUrl?: string | null;
  youtubeUrl?: string | null;
  xUrl?: string | null;
  telegramUrl?: string | null;
  socialAccounts?: SocialIdentity[];
}, client?: DbClient, options: DuplicateCheckOptions = {}): Promise<DuplicateMatch[]> {
  const db = client ?? await getDb();
  const domainKeys = [businessDomain(input.websiteUrl)].filter(
    (value): value is string => Boolean(value),
  );
  const allEmails = (input.emails ?? [])
    .filter((value) => isEmail(value))
    .map(normalizeEmail);

  const aliasKeys = [input.businessName, ...(input.aliases ?? [])]
    .filter((value): value is string => Boolean(value?.trim()))
    .map(normalizeName)
    .filter(Boolean);

  const accounts = identitySocialKeys(input);
  const profiles = [...new Set([input.websiteUrl,input.instagramUrl,input.youtubeUrl,input.telegramUrl,input.xUrl,...(input.socialAccounts??[]).map(a=>a.url)].map(sharedProfileKey).filter((v):v is string=>Boolean(v)))];
  // The exact same resolver runs in the DB write guards. One round trip,
  // no AI/network lookup, and no per-key LIMIT that could hide conflicting owners.
  const rows = await db.query<any>(`${PROSPECT_SELECT.replace("SELECT p.*,", "SELECT p.*, identity_match.reasons AS identity_reasons,")}
    JOIN growth_find_identity_matches($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::uuid) identity_match
      ON identity_match.prospect_id=p.id
    ORDER BY p.created_at, p.id`,
    [domainKeys,allEmails,aliasKeys,accounts.instagram,accounts.youtube,accounts.x,accounts.telegram,profiles,options.ignoreTarget ?? null]);
  return rows.rows.map(row => ({ prospect: mapProspect(row), reasons: row.identity_reasons }));
}

class ConcurrentProspectDuplicate extends Error {}

export interface SaveProspectInput extends LeadIntake {
  businessName: string;
  websiteUrl?: string | null;
  country?: string | null;
  categories: Category[];
  signalDescription?: string | null;
  pricingDetails?: string | null;
  evidenceSummary?: string | null;
  researchNotes?: string | null;
  email?: string | null;
  emailSourceUrl?: string | null;
  emailSourceType?: "official_website" | "official_social" | "official_directory" | "public_profile";
  instagramUrl?: string | null;
  youtubeUrl?: string | null;
  xUrl?: string | null;
  telegramUrl?: string | null;
  linkedinUrl?: string | null;
  otherSocials?: { label: string; url: string }[];
  followerCount?: string | null;
  subscriberCount?: string | null;
  sources?: { url: string; label: string; observedAt?: string; notes?: string }[];
  aliases?: string[];
  researchJobId?: string | null;
  qualificationStatus?: "candidate" | "verified";
  actorType?: "founder" | "chatgpt" | "claude" | "deepseek" | "api" | "seed" | "legacy";
  actorUserId?: string | null;
  actorKeyId?: string | null;
  sourceClient?: string | null;
  sourceAgent?: AgentTag | null;
  sourceChannel?: ChannelTag | null;
}

export interface SaveProspectResult {
  created: boolean;
  duplicate: boolean;
  resolution?: "created" | "already_exists" | "review_required";
  matches?: { prospectId: string; businessName: string; matchedOn: string[] }[];
  prospect: ProspectSummary | ProspectDetail;
  matchedOn?: string[];
  leadModel?: LeadModel;
}

export function duplicateResolution(matches: DuplicateMatch[]): "clear" | "already_exists" | "review_required" {
  if (!matches.length) return "clear";
  return matches.length !== 1 || matches[0].reasons.every(reason => reason === "business email domain" || reason === "business name or alias") ? "review_required" : "already_exists";
}

function duplicateResult(matches: DuplicateMatch[], prospect?: ProspectDetail): SaveProspectResult {
  return {
    created: false, duplicate: true, resolution: duplicateResolution(matches) as "already_exists" | "review_required",
    prospect: prospect ?? matches[0].prospect,
    matchedOn: [...new Set(matches.flatMap(match => match.reasons))],
    matches: matches.map(match => ({ prospectId: match.prospect.id, businessName: match.prospect.businessName, matchedOn: match.reasons })),
  };
}

function httpUrl(value: string | null | undefined, field: string): string {
  if (!value?.trim()) throw new AppError(`${field} is required.`);
  try {
    const parsed = new URL(
      /^https?:\/\//i.test(value) ? value : `https://${value}`,
    );
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
    return parsed.toString();
  } catch {
    throw new AppError(`${field} must be a valid public URL.`);
  }
}

export async function saveProspect(
  input: SaveProspectInput,
  provenance?: { aiProvider: string | null; aiModel: string | null },
): Promise<SaveProspectResult> {
  const businessName = input.businessName?.trim();
  if (!businessName || businessName.length < 2) {
    throw new AppError("A genuine business name is required.");
  }
  const intake = leadIntakeSchema.parse({leadAssessment:input.leadAssessment,audiences:input.audiences,contactRoutes:input.contactRoutes});
  if (!Array.isArray(input.categories) || !input.categories.length && !intake.leadAssessment) {
    throw new AppError("Select at least one verified trading category.");
  }
  const allowedCategories = new Set([
    "forex",
    "metals",
    "crypto",
    "indices",
    "commodities",
  ]);
  if (input.categories.some((category) => !allowedCategories.has(category))) {
    throw new AppError("One or more trading categories are invalid.");
  }

  // A caller's legacy label is never evidence. Insert as candidate; only the
  // modern assessment below may promote a NEW record, in this transaction.
  let savedQualification: "candidate" | "verified" | "rejected" = "candidate";
  let leadModel: LeadModel | undefined;
  // Every row records where it came from. An explicit tag wins; otherwise the actor type decides.
  const tags = tagsFromActorType(input.actorType);
  const websiteUrl = input.websiteUrl
    ? normalizeWebsiteUrl(input.websiteUrl)
    : null;
  const domainKey = businessDomain(websiteUrl);
  const email = input.email?.trim() ? normalizeEmail(input.email) : null;
  if (email) {
    if (!isEmail(email)) throw new AppError("Only a valid, publicly published business email can be saved.");
    input.emailSourceUrl = httpUrl(input.emailSourceUrl, "Published email source URL");
  }
  const socialAccounts = intake.audiences.map(a=>({platform:a.platform,url:a.accountUrl}));

  const duplicate = await checkDuplicate({
    businessName,
    websiteUrl,
    emails: email ? [email] : [],
    aliases: input.aliases,
    instagramUrl: input.instagramUrl,
    youtubeUrl: input.youtubeUrl,
    xUrl: input.xUrl,
    telegramUrl: input.telegramUrl,
    socialAccounts,
  });
  if (duplicate.length) {
    if (input.researchJobId) {
      await recordDuplicateRejection(input.researchJobId, {
        attemptedName: businessName,
        website: websiteUrl,
        email,
        existingProspectId: duplicate[0].prospect.id,
        existingName: duplicate[0].prospect.businessName,
        reasons: duplicate[0].reasons,
        actorType: input.actorType ?? "founder",
      });
    }
    const existing = await getProspect(duplicate[0].prospect.id);
    return duplicateResult(duplicate, existing ?? undefined);
  }

  const db = await getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const nameKey = normalizeName(businessName);
  const socialKeys = {
    instagram_key: normalizeHandle(input.instagramUrl, "instagram"),
    youtube_key: normalizeHandle(input.youtubeUrl, "youtube"),
    x_key: normalizeHandle(input.xUrl, "x"),
    telegram_key: normalizeHandle(input.telegramUrl, "telegram"),
  };

  try {
    await db.transaction(async (tx) => {
      // Serialize identity writers and recheck through THIS tx, including archived/excluded leads.
      await tx.query("LOCK TABLE prospects IN SHARE ROW EXCLUSIVE MODE");
      const raced = await checkDuplicate({ businessName, websiteUrl, emails: email ? [email] : [], aliases: input.aliases, instagramUrl: input.instagramUrl, youtubeUrl: input.youtubeUrl, xUrl: input.xUrl, telegramUrl: input.telegramUrl, socialAccounts }, tx);
      if (raced.length) throw new ConcurrentProspectDuplicate();
      await tx.query(
        `INSERT INTO prospects (
          id, business_name, name_key, website_url, domain_key, country, categories,
          signal_description, pricing_details, qualification_status, evidence_summary,
          research_notes, instagram_key, instagram_url, youtube_key, youtube_url,
          x_key, x_url, telegram_key, telegram_url, linkedin_url, other_socials,
          follower_count, subscriber_count, verified_at, status, research_job_id,
          created_by_type, created_by_user_id, created_by_key_id, source_client, source_agent, source_channel, metadata
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18, $19, $20, $21, $22::jsonb, $23, $24,
          $25, $26, $27, $28, $29, $30, $31, $32, $33, $34::jsonb
        )`,
        [
          id,
          businessName,
          nameKey,
          websiteUrl,
          domainKey,
          input.country?.trim() || null,
          JSON.stringify(input.categories),
          input.signalDescription?.trim() || null,
          input.pricingDetails?.trim() || null,
          "candidate",
          input.evidenceSummary?.trim() || null,
          input.researchNotes?.trim() || null,
          socialKeys.instagram_key,
          input.instagramUrl?.trim() || null,
          socialKeys.youtube_key,
          input.youtubeUrl?.trim() || null,
          socialKeys.x_key,
          input.xUrl?.trim() || null,
          socialKeys.telegram_key,
          input.telegramUrl?.trim() || null,
          input.linkedinUrl?.trim() || null,
          JSON.stringify(input.otherSocials ?? []),
          input.followerCount?.trim() || null,
          input.subscriberCount?.trim() || null,
          null,
          "new",
          input.researchJobId || null,
          input.actorType ?? "founder",
          input.actorUserId ?? null,
          input.actorKeyId ?? null,
          input.sourceClient ?? null,
          input.sourceAgent ?? tags.agent,
          input.sourceChannel ?? tags.channel,
          JSON.stringify({ verificationMethod: "public source review" }),
        ],
      );

      if (provenance) await tx.query("UPDATE prospects SET ai_provider=$1, ai_model=$2 WHERE id=$3",
        [provenance.aiProvider, provenance.aiModel, id]);
      await tx.query(
        `INSERT INTO prospect_aliases (id, prospect_id, alias, alias_key)
         VALUES ($1, $2, $3, $4)`,
        [crypto.randomUUID(), id, businessName, nameKey],
      );
      for (const alias of input.aliases ?? []) {
        const aliasKey = normalizeName(alias);
        if (aliasKey && aliasKey !== nameKey) {
          await tx.query(
            `INSERT INTO prospect_aliases (id, prospect_id, alias, alias_key)
             VALUES ($1, $2, $3, $4) ON CONFLICT (alias_key) DO NOTHING`,
            [crypto.randomUUID(), id, alias.trim(), aliasKey],
          );
        }
      }

      if (email && isEmail(email)) {
        await tx.query(
          `INSERT INTO prospect_emails
            (id, prospect_id, email, normalized_email, source_url, source_type,
             is_primary, verified_at)
           VALUES ($1, $2, $3, $4, $5, $6, true, $7)`,
          [
            crypto.randomUUID(),
            id,
            email,
            email,
            input.emailSourceUrl!,
            input.emailSourceType ?? "official_website",
            now,
          ],
        );
      }

      const sources = [...(input.sources ?? [])];
      if (
        input.emailSourceUrl &&
        !sources.some((source) => source.url === input.emailSourceUrl)
      ) {
        sources.push({
          url: input.emailSourceUrl,
          label: "Published contact email",
          observedAt: now,
          notes: "Official source used to confirm the contact email.",
        });
      }
      for (const source of sources) {
        const sourceUrl = httpUrl(source.url, "Evidence source URL");
        await tx.query(
          `INSERT INTO prospect_sources
            (id, prospect_id, url, label, source_type, observed_at, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            crypto.randomUUID(),
            id,
            sourceUrl,
            source.label?.trim() || "Public evidence",
            "website",
            source.observedAt || now,
            source.notes?.trim() || null,
          ],
        );
      }

      if (intake.leadAssessment) {
        for (const audience of intake.audiences) await saveAudienceObservation(id,{...audience,provenanceKey:crypto.randomUUID()},tx);
        for (const route of intake.contactRoutes) await saveContactRoute(id,{...route,provenanceKey:crypto.randomUUID()},tx);
        leadModel = await saveLeadAssessment(id,{
          ...intake.leadAssessment, sourceKind:"research", sourceAgent:input.sourceAgent ?? tags.agent,
          sourceReference:input.actorUserId ? `portal-user:${input.actorUserId}` : input.actorKeyId ? `agent-key:${input.actorKeyId}` : null,
          provenanceKey:crypto.randomUUID(),
        },tx);
        savedQualification = leadModel.eligibility === "eligible" ? "verified" : leadModel.eligibility === "excluded" ? "rejected" : "candidate";
        // Record what this row held before the assessment superseded it. Harmless today (this row
        // was inserted a few lines above, in this same transaction), and required once a later
        // reassessment calls this same path against an already-saved lead.
        const beforeAssessment = (await tx.query<{ qualification_status: string; status: string; rejection_reason: string | null; verified_at: string | null }>(
          `SELECT qualification_status, status, rejection_reason, verified_at::text AS verified_at FROM prospects WHERE id=$1`, [id],
        )).rows[0];
        const afterAssessment = (await tx.query<{ status: string; verified_at: string | null }>(
          `UPDATE prospects SET qualification_status=$2,verified_at=CASE WHEN $2='verified' THEN now() ELSE NULL END,
          status=CASE WHEN $2='verified' THEN 'verified' ELSE 'new' END,rejection_reason=$3 WHERE id=$1
          RETURNING status, verified_at::text AS verified_at`,[id,savedQualification,leadModel.exclusionReason])).rows[0];
        if (beforeAssessment) {
          await tx.query(`INSERT INTO audit_log (id,actor_type,actor_id,action,entity_type,entity_id,metadata)
            VALUES ($1,$2,$3,'lead.assessment_applied','prospect',$4,$5::jsonb)`,
            [crypto.randomUUID(), input.actorType ?? "founder", input.actorUserId ?? null, id, JSON.stringify({
              previousQualificationStatus: beforeAssessment.qualification_status,
              previousStatus: beforeAssessment.status,
              previousRejectionReason: beforeAssessment.rejection_reason,
              previousVerifiedAt: beforeAssessment.verified_at,
              newQualificationStatus: savedQualification,
              newRejectionReason: leadModel.exclusionReason,
              newStatus: afterAssessment.status,
              newVerifiedAt: afterAssessment.verified_at,
            })]);
        }
      }
      if (input.researchJobId) {
        await tx.query(
          `INSERT INTO research_events
            (id, job_id, event_type, prospect_id, detail, created_by_type)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [
            crypto.randomUUID(),
            input.researchJobId,
            savedQualification === "verified" ? "verified_saved" : "candidate_saved",
            id,
            JSON.stringify({ businessName, categories: input.categories }),
            input.actorType ?? "founder",
          ],
        );
      }
    });
  } catch (error) {
    if (isUniqueViolation(error) || error instanceof ConcurrentProspectDuplicate) {
      const afterRace = await checkDuplicate({
        businessName,
        websiteUrl,
        emails: email ? [email] : [],
        aliases: input.aliases,
        instagramUrl: input.instagramUrl,
        youtubeUrl: input.youtubeUrl,
        xUrl: input.xUrl,
        telegramUrl: input.telegramUrl,
        socialAccounts,
      });
      if (afterRace.length) {
        if (input.researchJobId) {
          await recordDuplicateRejection(input.researchJobId, {
            attemptedName: businessName,
            website: websiteUrl,
            email,
            existingProspectId: afterRace[0].prospect.id,
            existingName: afterRace[0].prospect.businessName,
            reasons: afterRace[0].reasons,
            actorType: input.actorType ?? "founder",
          });
        }
        return duplicateResult(afterRace);
      }
      throw new AppError(
        "A prospect with one of these identities already exists. Search Leads before retrying.",
        409,
        "duplicate",
      );
    }
    throw error;
  }

  if (input.researchJobId) {
    await refreshResearchJobStatus(input.researchJobId);
  }
  const created = await getProspect(id);
  if (!created) throw new AppError("Prospect could not be loaded.", 500);
  return { created: true, duplicate: false, resolution: "created", prospect: created, ...(leadModel ? {leadModel} : {}) };
}

async function recordDuplicateRejection(
  jobId: string,
  detail: Record<string, unknown> & { actorType?: string },
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO research_events
      (id, job_id, event_type, detail, created_by_type)
     VALUES ($1, $2, 'duplicate_rejected', $3::jsonb, $4)`,
    [
      crypto.randomUUID(),
      jobId,
      JSON.stringify(detail),
      String(detail.actorType ?? "founder"),
    ],
  );
}

export async function getProspect(
  id: string,
): Promise<ProspectDetail | null> {
  const db = await getDb();
  const result = await db.query<any>(
    `${PROSPECT_SELECT} WHERE p.id = $1 AND p.archived_at IS NULL LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  const [sources, emails, aliases] = await Promise.all([
    db.query<any>(
      `SELECT * FROM prospect_sources WHERE prospect_id = $1 ORDER BY observed_at DESC`,
      [id],
    ),
    db.query<any>(
      `SELECT * FROM prospect_emails WHERE prospect_id = $1 ORDER BY is_primary DESC, verified_at ASC`,
      [id],
    ),
    db.query<any>(
      `SELECT alias FROM prospect_aliases WHERE prospect_id = $1 ORDER BY created_at ASC`,
      [id],
    ),
  ]);
  return mapProspectDetail(
    row,
    sources.rows.map(mapSource),
    emails.rows.map(mapEmail),
    aliases.rows.map((alias) => alias.alias),
  );
}

export interface ProspectFilters {
  tier?: LeadFilters["tier"];
  productFit?: LeadFilters["productFit"];
  minPriority?: number;
  audience?: "unknown" | number;
  sort?: "priority" | "updated";
  query?: string;
  status?: string;
  qualification?: string;
  category?: string;
  jobId?: string;
  hasEmail?: boolean;
  /** Which agent produced the lead, normalised. Reporting only. */
  agent?: string;
  /** How it arrived: mcp_oauth, api_key, engine or founder. */
  channel?: string;
  /** A sending profile id, or "default" for leads not tied to one yet. */
  sender?: string;
  /** Which day window the row was added in, in the workspace timezone. */
  added?: AddedRange;
  addedFrom?: string;
  addedTo?: string;
  /** Injectable clock, so the day boundaries can be tested without waiting for midnight. */
  now?: Date;
  /** The IANA zone the day windows resolve in; defaults to the workspace setting. */
  timezone?: string;
  limit?: number;
  offset?: number;
}

/** The SQL for a workspace-day window on a timestamp column, pushing its two instants as params. */
function addedCondition(
  filters: ProspectFilters,
  column: string,
  params: unknown[],
): string | null {
  if (!filters.added) return null;
  const window = addedWindow(
    filters.added,
    filters.now ?? new Date(),
    filters.addedFrom,
    filters.addedTo,
    filters.timezone,
  );
  if (!window) return null;
  params.push(window.from.toISOString(), window.to.toISOString());
  return `${column} >= $${params.length - 1} AND ${column} < $${params.length}`;
}

/**
 * How many leads sit under each filter option, under the filters currently applied — each axis is
 * counted with every other filter applied but not its own, so an option shows what choosing it would
 * return right now. Every count is over the whole filtered set, never a page.
 */
export async function getProspectOriginFacets(
  filters: ProspectFilters = {},
): Promise<{
  agents: Record<string, number>;
  channels: Record<string, number>;
  senders: Record<string, number>;
  added: Record<string, number>;
  hasEmail: { yes: number; no: number };
}> {
  // One captured clock and one resolved zone for the whole call, so every axis counts the same window.
  filters = {
    ...filters,
    timezone: filters.timezone ?? (await getWorkspaceSettings()).timezone,
    now: filters.now ?? new Date(),
  };
  const db = await getDb();
  const conditions = ["p.archived_at IS NULL"];
  const params: unknown[] = [];
  if (filters.query?.trim()) {
    params.push(`%${filters.query.trim()}%`);
    const idx = params.length;
    conditions.push(
      `(p.business_name ILIKE $${idx} OR p.website_url ILIKE $${idx} OR p.country ILIKE $${idx} OR EXISTS (
        SELECT 1 FROM prospect_emails pe WHERE pe.prospect_id = p.id AND pe.email ILIKE $${idx}
      ))`,
    );
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`p.status = $${params.length}`);
  }
  if (filters.qualification) {
    params.push(filters.qualification);
    conditions.push(`p.qualification_status = $${params.length}`);
  }
  if (filters.category) {
    params.push(JSON.stringify([filters.category]));
    conditions.push(`p.categories @> $${params.length}::jsonb`);
  }
  if (filters.jobId) {
    params.push(filters.jobId);
    conditions.push(`p.research_job_id = $${params.length}`);
  }
  if (filters.hasEmail === true) {
    conditions.push(`EXISTS (SELECT 1 FROM prospect_emails pe WHERE pe.prospect_id = p.id)`);
  }
  if (filters.hasEmail === false) {
    conditions.push(`NOT EXISTS (SELECT 1 FROM prospect_emails pe WHERE pe.prospect_id = p.id)`);
  }

  conditions.push(leadModelConditions(filters, params));
  const where = conditions.join(" AND ");

  // Each filter as a clause another axis can carry. A clause pushes its parameter onto the array it
  // is given, so every axis keeps its own parameter list and the placeholders stay in step.
  const agentClause = (target: unknown[]): string | null => {
    if (filters.agent === "unknown") return `(p.source_agent IS NULL OR p.source_agent = 'unknown')`;
    if (filters.agent) {
      target.push(filters.agent);
      return `p.source_agent = $${target.length}`;
    }
    return null;
  };
  const channelClause = (target: unknown[]): string | null => {
    if (filters.channel === "unknown") return "p.source_channel IS NULL";
    if (filters.channel) {
      target.push(filters.channel);
      return `p.source_channel = $${target.length}`;
    }
    return null;
  };
  const senderClause = (target: unknown[]): string | null => {
    if (filters.sender === "default") return "p.sending_profile_id IS NULL";
    if (filters.sender) {
      target.push(filters.sender);
      return `p.sending_profile_id = $${target.length}`;
    }
    return null;
  };

  // Every axis is counted with all the filters applied except its own, and always over the whole
  // filtered set — so a count never moves because more rows were loaded.
  const agentParams: unknown[] = [...params];
  const agentWhere = [
    where,
    channelClause(agentParams),
    senderClause(agentParams),
    addedCondition(filters, "p.created_at", agentParams),
  ]
    .filter(Boolean)
    .join(" AND ");

  const channelParams: unknown[] = [...params];
  const channelWhere = [
    where,
    agentClause(channelParams),
    senderClause(channelParams),
    addedCondition(filters, "p.created_at", channelParams),
  ]
    .filter(Boolean)
    .join(" AND ");

  const senderParams: unknown[] = [...params];
  const senderWhere = [
    where,
    agentClause(senderParams),
    channelClause(senderParams),
    addedCondition(filters, "p.created_at", senderParams),
  ]
    .filter(Boolean)
    .join(" AND ");

  // One count per preset, each with every other filter applied and the added axis left open, so the
  // numbers say what choosing that range would return.
  const added: Record<string, number> = {};
  for (const range of COUNTED_ADDED_RANGES) {
    const rangeParams: unknown[] = [...params];
    const rangeWhere = [
      where,
      agentClause(rangeParams),
      channelClause(rangeParams),
      senderClause(rangeParams),
      addedCondition({ ...filters, added: range }, "p.created_at", rangeParams),
    ]
      .filter(Boolean)
      .join(" AND ");
    const rows = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM prospects p WHERE ${rangeWhere}`,
      rangeParams,
    );
    added[range] = Number(rows.rows[0]?.n ?? 0);
  }

  const senders = await db.query<{ sender: string; n: number }>(
    `SELECT coalesce(p.sending_profile_id::text, 'default') AS sender, count(*)::int AS n
       FROM prospects p WHERE ${senderWhere} GROUP BY 1`,
    senderParams,
  );

  const agents = await db.query<{ source_agent: string | null; n: number }>(
    `SELECT coalesce(p.source_agent, 'unknown') AS source_agent, count(*)::int AS n
       FROM prospects p WHERE ${agentWhere} GROUP BY 1`,
    agentParams,
  );
  const channels = await db.query<{ source_channel: string | null; n: number }>(
    `SELECT coalesce(p.source_channel, 'unknown') AS source_channel, count(*)::int AS n
       FROM prospects p WHERE ${channelWhere} GROUP BY 1`,
    channelParams,
  );
  const toMap = (rows: Record<string, unknown>[], field: string) =>
    Object.fromEntries(rows.map((row) => [String(row[field] ?? "unknown"), Number(row.n)]));
  const emailFilter = prospectWhere({ ...filters, hasEmail: undefined });
  const emailResult = await db.query<{ yes: number; no: number }>(
    `SELECT count(*) FILTER (WHERE EXISTS(SELECT 1 FROM prospect_emails pe WHERE pe.prospect_id = p.id))::int AS yes,
            count(*) FILTER (WHERE NOT EXISTS(SELECT 1 FROM prospect_emails pe WHERE pe.prospect_id = p.id))::int AS no
       FROM prospects p WHERE ${emailFilter.conditions.join(" AND ")}`,
    emailFilter.params,
  );
  return {
    agents: toMap(agents.rows, "source_agent"),
    channels: toMap(channels.rows, "source_channel"),
    senders: toMap(senders.rows, "sender"),
    added,
    hasEmail: {
      yes: Number(emailResult.rows[0]?.yes ?? 0),
      no: Number(emailResult.rows[0]?.no ?? 0),
    },
  };
}

/** The row cap for one page of the leads list; "Load more" grows the window by this much. */
export const PROSPECT_PAGE_SIZE = 150;

/** A ceiling for callers that pass their own limit to `listProspects`. The list page does not use it. */
const MAX_PROSPECT_LIMIT = 200;

/**
 * The WHERE for a lead filter, shared by the list, the count and the page so they can never disagree
 * about which rows match. The window (limit/offset) is applied by the caller, never here — which is
 * what keeps a count independent of the page size.
 */
function prospectWhere(filters: ProspectFilters): {
  conditions: string[];
  params: unknown[];
} {
  const conditions = ["p.archived_at IS NULL"];
  const params: unknown[] = [];
  if (filters.query?.trim()) {
    params.push(`%${filters.query.trim()}%`);
    const idx = params.length;
    conditions.push(
      `(p.business_name ILIKE $${idx} OR p.website_url ILIKE $${idx} OR p.country ILIKE $${idx} OR EXISTS (
        SELECT 1 FROM prospect_emails pe WHERE pe.prospect_id = p.id AND pe.email ILIKE $${idx}
      ))`,
    );
  }
  if (filters.status) {
    params.push(filters.status);
    conditions.push(`p.status = $${params.length}`);
  }
  if (filters.qualification) {
    params.push(filters.qualification);
    conditions.push(`p.qualification_status = $${params.length}`);
  }
  if (filters.category) {
    params.push(JSON.stringify([filters.category]));
    conditions.push(`p.categories @> $${params.length}::jsonb`);
  }
  if (filters.jobId) {
    params.push(filters.jobId);
    conditions.push(`p.research_job_id = $${params.length}`);
  }
  if (filters.agent === "unknown") {
    // Rows saved before the tags existed have no agent at all; the facet counts them as unknown, so
    // the filter has to match them too or choosing "Unknown" would return nothing.
    conditions.push(`(p.source_agent IS NULL OR p.source_agent = 'unknown')`);
  } else if (filters.agent) {
    params.push(filters.agent);
    conditions.push(`p.source_agent = $${params.length}`);
  }
  if (filters.sender === "default") {
    conditions.push("p.sending_profile_id IS NULL");
  } else if (filters.sender) {
    params.push(filters.sender);
    conditions.push(`p.sending_profile_id = $${params.length}`);
  }
  if (filters.channel === "unknown") {
    conditions.push(`(p.source_channel IS NULL OR p.source_channel = 'unknown')`);
  } else if (filters.channel) {
    params.push(filters.channel);
    conditions.push(`p.source_channel = $${params.length}`);
  }
  if (filters.hasEmail === true) {
    conditions.push(
      `EXISTS (SELECT 1 FROM prospect_emails pe WHERE pe.prospect_id = p.id)`,
    );
  }
  if (filters.hasEmail === false) {
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM prospect_emails pe WHERE pe.prospect_id = p.id)`,
    );
  }
  const added = addedCondition(filters, "p.created_at", params);
  if (added) conditions.push(added);
  conditions.push(leadModelConditions(filters, params));
  return { conditions, params };
}

export interface ProspectListPage {
  rows: ProspectSummary[];
  /** How many leads match the filters in total — the whole set, never just this window. */
  total: number;
  /** The window size actually used. */
  limit: number;
  offset: number;
  /** True while matching rows remain beyond this window. */
  hasMore: boolean;
}

export async function listProspects(
  filters: ProspectFilters = {},
): Promise<ProspectSummary[]> {
  filters = {
    ...filters,
    timezone: filters.timezone ?? (await getWorkspaceSettings()).timezone,
    now: filters.now ?? new Date(),
  };
  const db = await getDb();
  const { conditions, params } = prospectWhere(filters);
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), MAX_PROSPECT_LIMIT);
  const offset = Math.max(filters.offset ?? 0, 0);
  const queryParams = [...params, limit, offset];
  const result = await db.query<any>(
    `${PROSPECT_SELECT}
     WHERE ${conditions.join(" AND ")}
     ORDER BY ${filters.sort === "priority" ? leadPriorityOrderSql() : "p.updated_at DESC,p.id"}
     LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
    queryParams,
  );
  return result.rows.map(mapProspect);
}

/**
 * How many leads match the filters, over the whole set. The page size never changes this number, so
 * it is safe to print beside a capped window as its true total.
 */
export async function countProspects(filters: ProspectFilters = {}): Promise<number> {
  filters = {
    ...filters,
    timezone: filters.timezone ?? (await getWorkspaceSettings()).timezone,
    now: filters.now ?? new Date(),
  };
  const db = await getDb();
  const { conditions, params } = prospectWhere(filters);
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM prospects p WHERE ${conditions.join(" AND ")}`,
    params,
  );
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * One window of the leads list together with the true filtered total. The window never exceeds what
 * matches, so repeated "Load more" steps (each asking for the previous limit plus a page) always
 * reach the last row, and the total is what the header shows — never the loaded rows.
 */
export async function listProspectsPage(
  filters: ProspectFilters = {},
): Promise<ProspectListPage> {
  filters = {
    ...filters,
    timezone: filters.timezone ?? (await getWorkspaceSettings()).timezone,
    now: filters.now ?? new Date(),
  };
  const db = await getDb();
  const { conditions, params } = prospectWhere(filters);
  const offset = Math.max(filters.offset ?? 0, 0);
  const total = await countProspects(filters);
  const requested = Math.max(filters.limit ?? PROSPECT_PAGE_SIZE, 1);
  const limit = Math.min(requested, Math.max(total - offset, 0));
  const queryParams = [...params, limit, offset];
  const result = await db.query<any>(
    `${PROSPECT_SELECT}
     WHERE ${conditions.join(" AND ")}
     ORDER BY ${filters.sort === "priority" ? leadPriorityOrderSql() : "p.updated_at DESC,p.id"}
     LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
    queryParams,
  );
  const rows = result.rows.map(mapProspect);
  return { rows, total, limit, offset, hasMore: offset + rows.length < total };
}

export interface UpdateProspectInput {
  businessName?: string;
  websiteUrl?: string | null;
  country?: string | null;
  categories?: Category[];
  signalDescription?: string | null;
  pricingDetails?: string | null;
  evidenceSummary?: string | null;
  researchNotes?: string | null;
  founderNotes?: string | null;
  instagramUrl?: string | null;
  youtubeUrl?: string | null;
  xUrl?: string | null;
  telegramUrl?: string | null;
  linkedinUrl?: string | null;
  followerCount?: string | null;
  subscriberCount?: string | null;
  status?: PipelineStatus;
  nextAction?: string | null;
  nextActionAt?: string | null;
  doNotContact?: boolean;
  qualificationStatus?: "candidate" | "verified" | "rejected";
  rejectionReason?: string | null;
}

const FIELD_MAP: Record<string, string> = {
  country: "country",
  signalDescription: "signal_description",
  pricingDetails: "pricing_details",
  evidenceSummary: "evidence_summary",
  researchNotes: "research_notes",
  founderNotes: "founder_notes",
  followerCount: "follower_count",
  subscriberCount: "subscriber_count",
  status: "status",
  nextAction: "next_action",
  nextActionAt: "next_action_at",
  doNotContact: "do_not_contact",
  qualificationStatus: "qualification_status",
  rejectionReason: "rejection_reason",
  linkedinUrl: "linkedin_url",
};

export async function updateProspect(
  id: string,
  input: UpdateProspectInput,
  userId: string,
): Promise<ProspectDetail> {
  const existing = await getProspect(id);
  if (!existing) throw new AppError("Prospect not found.", 404);

  if (
    input.businessName !== undefined ||
    input.websiteUrl !== undefined ||
    input.instagramUrl !== undefined ||
    input.youtubeUrl !== undefined ||
    input.xUrl !== undefined ||
    input.telegramUrl !== undefined
  ) {
    // An identity edit to this existing lead: duplicates the founder already linked to it are its
    // own family, never a conflict. Every other lead (and the exact-address unique index) still is.
    const duplicate = await checkDuplicate({
      businessName: input.businessName ?? existing.businessName,
      websiteUrl:
        input.websiteUrl === undefined ? existing.websiteUrl : input.websiteUrl,
      aliases: existing.aliases,
      instagramUrl:
        input.instagramUrl === undefined
          ? existing.instagramUrl
          : input.instagramUrl,
      youtubeUrl:
        input.youtubeUrl === undefined ? existing.youtubeUrl : input.youtubeUrl,
      xUrl: input.xUrl === undefined ? existing.xUrl : input.xUrl,
      telegramUrl:
        input.telegramUrl === undefined
          ? existing.telegramUrl
          : input.telegramUrl,
    }, undefined, { ignoreTarget: id });
    if (duplicate.some((match) => match.prospect.id !== id)) {
      throw new AppError(
        "Those changes match another prospect already in Growth.",
        409,
        "duplicate",
      );
    }
  }

  const db = await getDb();
  const sets: string[] = [];
  const params: unknown[] = [];

  const add = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (input.businessName !== undefined) {
    const name = input.businessName.trim();
    if (name.length < 2) throw new AppError("Business name is too short.");
    add("business_name", name);
    add("name_key", normalizeName(name));
  }
  if (input.websiteUrl !== undefined) {
    const website = input.websiteUrl
      ? normalizeWebsiteUrl(input.websiteUrl)
      : null;
    add("website_url", website);
    add("domain_key", businessDomain(website));
  }
  for (const [field, column] of Object.entries(FIELD_MAP)) {
    if (field in input) {
      add(column, (input as Record<string, unknown>)[field] ?? null);
    }
  }
  if (input.categories !== undefined) {
    add("categories", JSON.stringify(input.categories));
  }
  if (input.instagramUrl !== undefined) {
    add("instagram_url", input.instagramUrl);
    add("instagram_key", normalizeHandle(input.instagramUrl, "instagram"));
  }
  if (input.youtubeUrl !== undefined) {
    add("youtube_url", input.youtubeUrl);
    add("youtube_key", normalizeHandle(input.youtubeUrl, "youtube"));
  }
  if (input.xUrl !== undefined) {
    add("x_url", input.xUrl);
    add("x_key", normalizeHandle(input.xUrl, "x"));
  }
  if (input.telegramUrl !== undefined) {
    add("telegram_url", input.telegramUrl);
    add("telegram_key", normalizeHandle(input.telegramUrl, "telegram"));
  }
  add("founder_edited_at", new Date().toISOString());
  add("updated_at", new Date().toISOString());

  params.push(id);
  try {
    await db.transaction(async (tx) => {
      if (["businessName","websiteUrl","instagramUrl","youtubeUrl","xUrl","telegramUrl"].some(key => key in input)) {
        await tx.query("LOCK TABLE prospects IN SHARE ROW EXCLUSIVE MODE");
        const raced = await checkDuplicate({ businessName: input.businessName ?? existing.businessName, websiteUrl: input.websiteUrl === undefined ? existing.websiteUrl : input.websiteUrl, aliases: existing.aliases, instagramUrl: input.instagramUrl === undefined ? existing.instagramUrl : input.instagramUrl, youtubeUrl: input.youtubeUrl === undefined ? existing.youtubeUrl : input.youtubeUrl, xUrl: input.xUrl === undefined ? existing.xUrl : input.xUrl, telegramUrl: input.telegramUrl === undefined ? existing.telegramUrl : input.telegramUrl }, tx, { ignoreTarget: id });
        if (raced.some(match => match.prospect.id !== id)) throw new AppError("Those changes match another existing business.", 409, "duplicate");
      }
      if (input.qualificationStatus === "verified") {
        // Close the candidate -> edit -> verified bypass without reclassifying already-verified
        // historical rows. The bar is the MODEL half of the shared qualified-target definition the
        // research counts use: the lead model this record ALREADY had reads as eligible Tier 1 /
        // Other. (The count's other conditions — a source-backed email, not archived/rejected/linked
        // duplicate — are enforced by the count predicate itself; an archived lead has no page and
        // 404s before reaching here.) It is checked before the edit, so changing a website or
        // identity cannot quietly turn a non-counting record into a counted one — that needs a fresh
        // assessment, which re-derives the tier from current evidence. An email-no-website or
        // Category B record therefore stays a candidate here; only the assessment's own derivation
        // in saveProspect may label it. Hold the lead lock while checking.
        const current = (await tx.query<{ qualification_status: string }>(
          "SELECT qualification_status FROM prospects WHERE id=$1 FOR UPDATE", [id],
        )).rows[0];
        if (current?.qualification_status !== "verified") {
          const model = await getLeadModel(id, tx);
          if (!model.assessmentId || !isQualifiedTargetModel(model)) {
            throw new AppError("A modern eligible assessment is required before verifying this lead.", 400, "assessment_required");
          }
        }
      }
      await tx.query(
        `UPDATE prospects SET ${sets.join(", ")} WHERE id = $${params.length}`,
        params,
      );
      if (input.businessName !== undefined) {
        await tx.query(
          `INSERT INTO prospect_aliases (id, prospect_id, alias, alias_key)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (alias_key) DO NOTHING`,
          [
            crypto.randomUUID(),
            id,
            input.businessName.trim(),
            normalizeName(input.businessName),
          ],
        );
      }
      if (input.doNotContact === true) {
        const email = existing.contactEmail;
        if (email) {
          await tx.query(
            `INSERT INTO suppressions
              (id, normalized_email, email, reason, source, prospect_id, note)
             VALUES ($1, $2, $3, 'manual', 'founder', $4, $5)
             ON CONFLICT (normalized_email) DO UPDATE
             SET active = true, reason = 'manual', updated_at = now()`,
            [
              crypto.randomUUID(),
              normalizeEmail(email),
              email,
              id,
              "Marked do not contact from lead detail.",
            ],
          );
        }
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError(
        "Those changes conflict with another prospect's identity.",
        409,
        "duplicate",
      );
    }
    throw error;
  }

  const updated = await getProspect(id);
  if (!updated) throw new AppError("Prospect not found.", 404);
  return updated;
}

/**
 * Keeps a lead out of the automatic follow-up job, without banning contact.
 *
 * Exclusion is not suppression: nothing is written to `suppressions`, and the founder can still write
 * to the lead deliberately from the editor. `do_not_contact` is a different promise — no contact at
 * all — so this never touches that column, only `follow_up_excluded`.
 */
export async function setFollowUpExclusion(
  prospectId: string,
  excluded: boolean,
): Promise<boolean> {
  const db = await getDb();
  const result = await db.query<{ follow_up_excluded: boolean }>(
    `UPDATE prospects SET follow_up_excluded = $2, updated_at = now()
     WHERE id = $1 AND archived_at IS NULL
     RETURNING follow_up_excluded`,
    [prospectId, excluded],
  );
  const row = result.rows[0];
  if (!row) throw new AppError("Prospect not found.", 404, "prospect_not_found");
  return Boolean(row.follow_up_excluded);
}

export async function addProspectSource(
  prospectId: string,
  input: { url: string; label: string; notes?: string | null },
): Promise<ProspectDetail> {
  const prospect = await getProspect(prospectId);
  if (!prospect) throw new AppError("Prospect not found.", 404);
  const db = await getDb();
  await db.query(
    `INSERT INTO prospect_sources (id, prospect_id, url, label, source_type, notes, observed_at)
     VALUES ($1, $2, $3, $4, 'website', $5, $6)`,
    [
      crypto.randomUUID(),
      prospectId,
      httpUrl(input.url, "Source URL"),
      input.label.trim() || "Public evidence",
      input.notes?.trim() || null,
      new Date().toISOString(),
    ],
  );
  const updated = await getProspect(prospectId);
  return updated!;
}

export async function archiveProspect(id: string, userId: string): Promise<void> {
  const db = await getDb();
  const prospect = await getProspect(id);
  if (!prospect) throw new AppError("Prospect not found.", 404);
  await db.transaction(async (tx) => {
    await tx.query(
      `UPDATE prospects SET archived_at = now(), status = 'lost',
        do_not_contact = true, next_action = 'Archived', updated_at = now()
       WHERE id = $1`,
      [id],
    );
    await tx.query(
      `UPDATE drafts SET status = 'cancelled', updated_at = now()
       WHERE prospect_id = $1 AND status IN ('draft', 'approved')`,
      [id],
    );
    if (prospect.contactEmail) {
      await tx.query(
        `INSERT INTO suppressions
          (id, normalized_email, email, reason, source, prospect_id, note)
         VALUES ($1, $2, $3, 'manual', 'founder', $4, 'Archived and marked no further contact.')
         ON CONFLICT (normalized_email) DO UPDATE SET active = true, updated_at = now()`,
        [
          crypto.randomUUID(),
          normalizeEmail(prospect.contactEmail),
          prospect.contactEmail,
          id,
        ],
      );
    }
    await tx.query(
      `INSERT INTO audit_log
        (id, actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ($1, 'founder', $2, 'prospect.archived', 'prospect', $3, '{}'::jsonb)`,
      [crypto.randomUUID(), userId, id],
    );
  });
}

/**
 * Records an address the founder typed, after the research could not find one.
 *
 * It is stored as a founder-entered contact so the send gate allows it, and so the lead still shows
 * which addresses came from a source and which came from the founder. A duplicate address for the
 * same lead is a no-op. A conflicting identity is an explicit refusal, not a silently swallowed
 * write failure. Send reservations supply their transaction client so association and reservation
 * either both commit or both roll back.
 */
export async function recordFounderEnteredEmail(
  prospectId: string,
  email: string,
  client?: DbClient,
): Promise<void> {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  const db = client ?? await getDb();
  try {
    const inserted = await db.query(
      `INSERT INTO prospect_emails
         (id, prospect_id, email, normalized_email, source_url, source_type, is_primary, verified_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'Entered by the founder in the portal.', 'founder_entered', false, now())
       ON CONFLICT DO NOTHING RETURNING id`,
      [prospectId, normalized, normalized],
    );
    if (!inserted.rows.length) {
      // DO NOTHING covers two cases. The same lead already holding the address is a no-op; any other
      // skip means the exact address belongs to another lead (a linked duplicate included, which the
      // identity guard exempts by family). It stays with that lead: refuse instead of a silent no-op.
      const own = await db.query(`SELECT 1 FROM prospect_emails WHERE prospect_id = $1 AND normalized_email = $2 LIMIT 1`, [prospectId, normalized]);
      if (!own.rows.length) throw new AppError("This exact address is already recorded on another lead, including a lead linked as a duplicate. It stays with that lead; nothing was moved.",409,"duplicate_contact");
    }
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError("This contact identity overlaps another recorded lead. Review the duplicate before adding the address.",409,"duplicate_contact");
    throw error;
  }
}

export async function getProspectEmails(prospectId: string): Promise<string[]> {
  const db = await getDb();
  const result = await db.query<{ email: string }>(
    `SELECT email FROM prospect_emails WHERE prospect_id = $1 ORDER BY is_primary DESC`,
    [prospectId],
  );
  return result.rows.map((row) => row.email);
}

export async function getProspectConversationContext(prospectId: string) {
  const db = await getDb();
  const prospect = await getProspect(prospectId);
  if (!prospect) return null;
  const conversation = await db.query<any>(
    `SELECT * FROM conversations WHERE prospect_id = $1 LIMIT 1`,
    [prospectId],
  );
  const messages = conversation.rows[0]
    ? await db.query<any>(
        // The most recent messages by the time they really happened, newest first: `created_at` is
        // the import time for imported rows, so ordering by it picked an arbitrary set.
        `SELECT direction, from_email, subject, body_text, sent_at, received_at, source, external
         FROM messages WHERE conversation_id = $1 ORDER BY ${newestMessageFirst()} LIMIT 20`,
        [conversation.rows[0].id],
      )
    : { rows: [] };
  const drafts = await db.query<any>(
    `SELECT id, kind, sequence, status, subject, body, updated_at
     FROM drafts WHERE prospect_id = $1 ORDER BY sequence DESC, created_at DESC`,
    [prospectId],
  );
  return {
    prospect,
    conversation: conversation.rows[0] ?? null,
    messages: messages.rows.map((row) => ({
      direction: row.direction,
      from: row.from_email,
      subject: row.subject,
      body: row.body_text,
      sentAt: iso(row.sent_at),
      receivedAt: iso(row.received_at),
      source: row.source,
      external: Boolean(row.external),
    })),
    drafts: drafts.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      sequence: number(row.sequence),
      status: row.status,
      subject: row.subject,
      body: row.body,
      updatedAt: iso(row.updated_at),
    })),
  };
}

export async function databaseReady(): Promise<boolean> {
  try {
    const db = await getDb();
    await db.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

export async function exportProspectsForBackup(): Promise<string> {
  const db = await getDb();
  const [prospects, emails, sources, drafts, messages] = await Promise.all([
    db.query<any>("SELECT * FROM prospects WHERE archived_at IS NULL ORDER BY created_at"),
    db.query<any>("SELECT * FROM prospect_emails ORDER BY created_at"),
    db.query<any>("SELECT * FROM prospect_sources ORDER BY created_at"),
    db.query<any>("SELECT * FROM drafts ORDER BY created_at"),
    db.query<any>("SELECT * FROM messages ORDER BY created_at"),
  ]);
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      schema: "nomeriq-growth-v1",
      prospects: prospects.rows,
      emails: emails.rows,
      sources: sources.rows,
      drafts: drafts.rows,
      messages: messages.rows,
    },
    null,
    2,
  );
}

export async function countProspectsByStatus(
  tx: DbClient = undefined as unknown as DbClient,
): Promise<Record<string, number>> {
  const db = tx ?? (await getDb());
  const result = await db.query<{ status: string; count: string | number }>(
    `SELECT status, count(*) AS count FROM prospects
     WHERE archived_at IS NULL GROUP BY status`,
  );
  return Object.fromEntries(
    result.rows.map((row) => [row.status, number(row.count)]),
  );
}

export function categoriesLabel(categories: string[]): string {
  return asStringArray(categories).join(" · ");
}
