import { getDb, type DbClient } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import { tagsFromActorType } from "@/lib/agent/agentTag";
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
import { refreshResearchJobStatus } from "./research";

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

export async function checkDuplicate(input: {
  businessName?: string | null;
  websiteUrl?: string | null;
  emails?: string[];
  aliases?: string[];
  instagramUrl?: string | null;
  youtubeUrl?: string | null;
  xUrl?: string | null;
  telegramUrl?: string | null;
}): Promise<DuplicateMatch[]> {
  const db = await getDb();
  const domainKeys = [domainFromUrl(input.websiteUrl)].filter(
    (value): value is string => Boolean(value),
  );
  const allEmails = (input.emails ?? [])
    .filter((value) => isEmail(value))
    .map(normalizeEmail);
  // info@ / support@ can be shared by unrelated businesses. Match those only
  // when another strong identity (domain, name, social) already matches.
  const emails = allEmails.filter((value) => !isGenericBusinessEmail(value));
  const aliasKeys = [input.businessName, ...(input.aliases ?? [])]
    .filter((value): value is string => Boolean(value?.trim()))
    .map(normalizeName)
    .filter(Boolean);

  const found = new Map<string, DuplicateMatch>();

  const addRows = (rows: any[], reason: string) => {
    for (const row of rows) {
      const existing = found.get(row.id);
      if (existing) {
        if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      } else {
        found.set(row.id, { prospect: mapProspect(row), reasons: [reason] });
      }
    }
  };

  if (domainKeys.length) {
    const rows = await db.query<any>(
      `${PROSPECT_SELECT}
       WHERE p.archived_at IS NULL AND p.domain_key = ANY($1::text[])
       LIMIT 5`,
      [domainKeys],
    );
    addRows(rows.rows, "official website domain");
  }

  if (emails.length) {
    const rows = await db.query<any>(
      `${PROSPECT_SELECT}
       WHERE p.archived_at IS NULL
         AND EXISTS (
           SELECT 1 FROM prospect_emails pe
           WHERE pe.prospect_id = p.id
             AND pe.normalized_email = ANY($1::text[])
         )
       LIMIT 5`,
      [emails],
    );
    addRows(rows.rows, "contact email");
  }

  if (aliasKeys.length) {
    const rows = await db.query<any>(
      `${PROSPECT_SELECT}
       WHERE p.archived_at IS NULL
         AND EXISTS (
           SELECT 1 FROM prospect_aliases pa
           WHERE pa.prospect_id = p.id
             AND pa.alias_key = ANY($1::text[])
         )
       LIMIT 5`,
      [aliasKeys],
    );
    addRows(rows.rows, "business name or alias");
  }

  const socials = {
    instagram_key: normalizeHandle(input.instagramUrl, "instagram"),
    youtube_key: normalizeHandle(input.youtubeUrl, "youtube"),
    x_key: normalizeHandle(input.xUrl, "x"),
    telegram_key: normalizeHandle(input.telegramUrl, "telegram"),
  };
  const socialLabels: Record<string, string> = {
    instagram_key: "Instagram handle",
    youtube_key: "YouTube channel",
    x_key: "X handle",
    telegram_key: "Telegram handle",
  };
  const activeSocials = Object.entries(socials).filter(([, value]) => value);
  if (activeSocials.length) {
    const rows = await db.query<any>(
      `${PROSPECT_SELECT}
       WHERE p.archived_at IS NULL AND (
         p.instagram_key = ANY($1::text[]) OR
         p.youtube_key = ANY($2::text[]) OR
         p.x_key = ANY($3::text[]) OR
         p.telegram_key = ANY($4::text[])
       )
       LIMIT 5`,
      [
        socials.instagram_key ? [socials.instagram_key] : [],
        socials.youtube_key ? [socials.youtube_key] : [],
        socials.x_key ? [socials.x_key] : [],
        socials.telegram_key ? [socials.telegram_key] : [],
      ],
    );
    for (const row of rows.rows) {
      const reasons = activeSocials
        .filter(([column, value]) => row[column] && row[column] === value)
        .map(([column]) => socialLabels[column]);
      addRows([row], reasons[0] ?? "social identity");
      const match = found.get(row.id);
      if (match) {
        for (const reason of reasons) {
          if (!match.reasons.includes(reason)) match.reasons.push(reason);
        }
      }
    }
  }

  return [...found.values()];
}

export interface SaveProspectInput {
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
  actorType?: "founder" | "chatgpt" | "claude" | "deepseek" | "api" | "seed";
  actorUserId?: string | null;
  actorKeyId?: string | null;
  sourceClient?: string | null;
  sourceAgent?: AgentTag | null;
  sourceChannel?: ChannelTag | null;
}

export interface SaveProspectResult {
  created: boolean;
  duplicate: boolean;
  prospect: ProspectSummary | ProspectDetail;
  matchedOn?: string[];
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
): Promise<SaveProspectResult> {
  const businessName = input.businessName?.trim();
  if (!businessName || businessName.length < 2) {
    throw new AppError("A genuine business name is required.");
  }
  if (!Array.isArray(input.categories) || input.categories.length === 0) {
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

  const qualification = input.qualificationStatus ?? "verified";
  // Every row records where it came from. An explicit tag wins; otherwise the actor type decides.
  const tags = tagsFromActorType(input.actorType);
  const websiteUrl = input.websiteUrl
    ? normalizeWebsiteUrl(input.websiteUrl)
    : null;
  const domainKey = domainFromUrl(websiteUrl);
  const email = input.email?.trim() ? normalizeEmail(input.email) : null;

  if (qualification === "verified") {
    if (!websiteUrl) {
      throw new AppError("A verified lead needs an official website.");
    }
    if (!email || !isEmail(email)) {
      throw new AppError(
        "A verified lead needs a source-confirmed public contact email.",
      );
    }
    const emailSourceUrl = httpUrl(
      input.emailSourceUrl,
      "Email source URL",
    );
    if (!input.signalDescription?.trim()) {
      throw new AppError("Describe the commercial signal service before saving.");
    }
    if (!(input.sources ?? []).length) {
      throw new AppError(
        "Add at least one public evidence source for the signal service.",
      );
    }
    input.emailSourceUrl = emailSourceUrl;
  }

  const duplicate = await checkDuplicate({
    businessName,
    websiteUrl,
    emails: email ? [email] : [],
    aliases: input.aliases,
    instagramUrl: input.instagramUrl,
    youtubeUrl: input.youtubeUrl,
    xUrl: input.xUrl,
    telegramUrl: input.telegramUrl,
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
    return {
      created: false,
      duplicate: true,
      prospect: existing ?? duplicate[0].prospect,
      matchedOn: duplicate[0].reasons,
    };
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
          qualification,
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
          qualification === "verified" ? now : null,
          qualification === "verified" ? "verified" : "new",
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

      if (input.researchJobId) {
        await tx.query(
          `INSERT INTO research_events
            (id, job_id, event_type, prospect_id, detail, created_by_type)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [
            crypto.randomUUID(),
            input.researchJobId,
            qualification === "verified" ? "verified_saved" : "candidate_saved",
            id,
            JSON.stringify({ businessName, categories: input.categories }),
            input.actorType ?? "founder",
          ],
        );
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const afterRace = await checkDuplicate({
        businessName,
        websiteUrl,
        emails: email ? [email] : [],
        aliases: input.aliases,
        instagramUrl: input.instagramUrl,
        youtubeUrl: input.youtubeUrl,
        xUrl: input.xUrl,
        telegramUrl: input.telegramUrl,
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
        return {
          created: false,
          duplicate: true,
          prospect: afterRace[0].prospect,
          matchedOn: afterRace[0].reasons,
        };
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
  return { created: true, duplicate: false, prospect: created };
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
  limit?: number;
  offset?: number;
}

/**
 * How many leads each agent and each channel has, under the filters currently applied — the agent and
 * channel narrowing is excluded from its own count so every option shows what choosing it would give.
 */
export async function getProspectOriginFacets(
  filters: ProspectFilters = {},
): Promise<{ agents: Record<string, number>; channels: Record<string, number> }> {
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

  // Each axis is counted with every filter applied except its own, so an option shows what choosing
  // it would return right now — and the other axis' narrowing does move the numbers.
  const where = conditions.join(" AND ");

  // The agent counts carry the channel filter, and the channel counts carry the agent filter.
  const agentParams = [...params];
  let agentWhere = where;
  if (filters.channel && filters.channel !== "unknown") {
    agentParams.push(filters.channel);
    agentWhere = `${where} AND p.source_channel = $${agentParams.length}`;
  } else if (filters.channel === "unknown") {
    agentWhere = `${where} AND p.source_channel IS NULL`;
  }

  const channelParams = [...params];
  let channelWhere = where;
  if (filters.agent && filters.agent !== "unknown") {
    channelParams.push(filters.agent);
    channelWhere = `${where} AND p.source_agent = $${channelParams.length}`;
  } else if (filters.agent === "unknown") {
    channelWhere = `${where} AND (p.source_agent IS NULL OR p.source_agent = 'unknown')`;
  }

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
  return {
    agents: toMap(agents.rows, "source_agent"),
    channels: toMap(channels.rows, "source_channel"),
  };
}

export async function listProspects(
  filters: ProspectFilters = {},
): Promise<ProspectSummary[]> {
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
  if (filters.agent === "unknown") {
    // Rows saved before the tags existed have no agent at all; the facet counts them as unknown, so
    // the filter has to match them too or choosing "Unknown" would return nothing.
    conditions.push(`(p.source_agent IS NULL OR p.source_agent = 'unknown')`);
  } else if (filters.agent) {
    params.push(filters.agent);
    conditions.push(`p.source_agent = $${params.length}`);
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
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  params.push(limit, offset);
  const result = await db.query<any>(
    `${PROSPECT_SELECT}
     WHERE ${conditions.join(" AND ")}
     ORDER BY p.updated_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return result.rows.map(mapProspect);
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
    });
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
    add("domain_key", domainFromUrl(website));
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
        `SELECT direction, from_email, subject, body_text, sent_at, received_at, source, external
         FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 20`,
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
