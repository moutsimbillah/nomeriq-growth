import { getDb, type DbClient } from "@/lib/db/client";
import { AppError, domainFromUrl, iso, json, normalizeHandle } from "@/lib/utils";
import { z } from "zod";
import { checkDuplicate } from "@/lib/services/prospects";
import { businessDomain } from "@/lib/leads/identity";
import { assessmentSchema, audienceSchema, routeSchema, findingSchema, emptyLeadModel, establishedAudience, priorityFor, supportedFit, totalPriority, LEAD_RULES_VERSION, type AssessmentInput, type LeadModel, type LeadFinding, type LeadTier } from "@/lib/leads/model";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
const JSON_COLUMNS = new Set(["eligibility_checks", "capability_gaps", "findings", "sources_checked", "missing_information", "priority_components", "legacy_snapshot", "value"]);
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function comparable(key: string, value: any): any {
  return JSON_COLUMNS.has(key) ? json(value, value) : key.endsWith("_at") ? iso(value) : key === "count_value" && value !== null ? Number(value) : value;
}
/** Append only; retrying one provenance key with different facts is a conflict, not an overwrite. */
async function append(db: DbClient, table: string, values: Row): Promise<string> {
  const old = (await db.query<Row>(`SELECT * FROM ${table} WHERE provenance_key=$1`, [values.provenance_key])).rows[0];
  if (old) {
    if (Object.entries(values).some(([k, v]) => stable(comparable(k, old[k])) !== stable(comparable(k, v)))) throw new AppError("This provenance key already records different facts.", 409, "assessment_replay_conflict");
    return old.id;
  }
  const keys = Object.keys(values);
  const id = crypto.randomUUID();
  await db.query(`INSERT INTO ${table} (id,${keys.join(",")}) VALUES ($1,${keys.map((k, i) => `$${i + 2}${JSON_COLUMNS.has(k) ? "::jsonb" : ""}`).join(",")})`, [id, ...keys.map(k => JSON_COLUMNS.has(k) && values[k] !== null ? JSON.stringify(values[k]) : values[k])]);
  return id;
}
async function lockedLead(db: DbClient, id: string): Promise<Row> {
  const lead = (await db.query<Row>("SELECT * FROM prospects WHERE id=$1 FOR UPDATE", [id])).rows[0];
  if (!lead) throw new AppError("Lead not found.", 404, "prospect_not_found");
  return lead;
}
function officialSource(value: string, lead: Row): boolean {
  try {
  const url = new URL(value);
  const website = lead.website_url ? new URL(lead.website_url) : null;
  const shared = new Set(["instagram.com", "youtube.com", "t.me", "telegram.me", "linktr.ee", "x.com", "twitter.com"]);
  if (website && !shared.has(domainFromUrl(website.href) ?? "") && domainFromUrl(url.href) === domainFromUrl(website.href)) return true;
  return [lead.instagram_url, lead.youtube_url, lead.telegram_url, lead.x_url].filter(Boolean).some((source: string) => {
    try { const profile = new URL(source); const p = profile.pathname.replace(/\/$/, ""); return url.hostname.replace(/^www\./, "") === profile.hostname.replace(/^www\./, "") && (url.pathname.replace(/\/$/, "") === p || Boolean(p && url.pathname.startsWith(p + "/"))); }
    catch { return false; }
  });
  } catch { return false; }
}
function requireOfficialEvidence(findings: LeadFinding[], lead: Row): void {
  if (findings.some(f => !officialSource(f.sourceUrl, lead))) throw new AppError("Assessment findings must come from this business's official site or linked profile.", 400, "unlinked_assessment_source");
}
async function uniqueBusiness(db: DbClient, lead: Row): Promise<boolean> {
  const emails = (await db.query<{ normalized_email: string }>("SELECT normalized_email FROM prospect_emails WHERE prospect_id=$1", [lead.id])).rows.map(e => e.normalized_email);
  const aliases = (await db.query<{alias:string}>("SELECT alias FROM prospect_aliases WHERE prospect_id=$1",[lead.id])).rows.map(a=>a.alias);
  const socialAccounts = (await db.query<{platform:"instagram"|"youtube"|"telegram";url:string}>("SELECT platform,account_url AS url FROM prospect_audience_observations WHERE prospect_id=$1",[lead.id])).rows;
  const matches = await checkDuplicate({businessName:lead.business_name,websiteUrl:lead.website_url,emails,aliases,instagramUrl:lead.instagram_url,youtubeUrl:lead.youtube_url,telegramUrl:lead.telegram_url,xUrl:lead.x_url,socialAccounts},db);
  return matches.every(match=>match.prospect.id===lead.id);
}
export async function saveLeadAssessment(prospectId: string, input: AssessmentInput, client?: DbClient): Promise<LeadModel> {
  const data = assessmentSchema.parse(input);
  const db = client ?? await getDb();
  return db.transaction(async tx => {
    const lead = await lockedLead(tx, prospectId);
    requireOfficialEvidence([...data.findings, ...data.capabilityGaps], lead);
    const emails = (await tx.query<Row>("SELECT * FROM prospect_emails WHERE prospect_id=$1", [prospectId])).rows;
    const checks = {
      paidSignals: data.findings.some(f => f.area === "paid_signals" && f.verdict === "present"),
      eligibleMarket: json<string[]>(lead.categories, []).some(c => ["forex", "metals", "crypto", "indices", "commodities"].includes(c)) && data.findings.some(f => f.area === "markets" && f.verdict === "present"),
      publishedEmail: emails.some(e => e.source_type !== "founder_entered" && officialSource(e.source_url, lead)) && data.findings.some(f => f.area === "email" && f.verdict === "present"),
      officialWebsite: Boolean(businessDomain(lead.website_url)),
      uniqueBusiness: await uniqueBusiness(tx, lead),
      active: data.findings.some(f => f.area === "activity" && f.verdict === "present"),
    };
    const base = await getLeadModel(prospectId, tx);
    const routes = base.contactRoutes.some(r => r.officialStatus === "verified");
    const businessEligible = checks.paidSignals && checks.eligibleMarket && checks.uniqueBusiness && checks.active;
    let tier: LeadTier | null = null;
    let eligibility = data.eligibility;
    if (eligibility === "excluded") tier = "excluded";
    else if (businessEligible && checks.publishedEmail) { tier = checks.officialWebsite ? establishedAudience(base.audiences) ? "tier_1" : "other" : "email_no_website"; eligibility = "eligible"; }
    else if (businessEligible && !emails.some(e => e.source_type !== "founder_entered") && routes) { tier = "category_b"; eligibility = "eligible"; }
    else eligibility = "unknown";
    const fit = supportedFit(data);
    const model: LeadModel = { ...base, tier, eligibility, productFit: fit, findings: data.findings, capabilityGaps: data.capabilityGaps, assessedAt: data.assessedAt };
    const components = priorityFor(model, new Date(data.assessedAt));
    await append(tx, "prospect_assessments", {
      prospect_id: prospectId, rules_version: LEAD_RULES_VERSION, assessed_at: new Date(data.assessedAt).toISOString(),
      source_kind: data.sourceKind, source_reference: data.sourceReference, source_agent: data.sourceAgent,
      ai_provider: data.aiProvider, ai_model: data.aiModel, eligibility, eligibility_checks: checks,
      exclusion_reason: data.exclusionReason, tier, platform_maturity: data.findings.some(f=>["delivery","membership","dashboard","publishing","performance","payments"].includes(f.area) && f.verdict==="present") ? data.platformMaturity : "unknown",
      mobile_app_status: data.mobileAppStatus === "verified_present" && !data.findings.some(f => f.area === "app" && f.verdict === "present") || data.mobileAppStatus === "verified_absent" && !data.findings.some(f => f.area === "app" && f.verdict === "absent") ? "unknown" : data.mobileAppStatus,
      product_fit: fit, capability_gaps: data.capabilityGaps, findings: data.findings, sources_checked: data.sourcesChecked,
      missing_information: data.missingInformation, fit_reasoning: fit === "unknown" && data.productFit !== "unknown" ? "Insufficient supporting infrastructure evidence; fit needs research." : data.fitReasoning,
      research_confidence: data.researchConfidence, priority_score: tier && tier !== "excluded" ? totalPriority(components) : null,
      priority_components: components, priority_provisional: fit === "unknown", legacy_snapshot: data.legacySnapshot,
      provenance_key: data.provenanceKey, created_by: null,
    });
    return getLeadModel(prospectId, tx);
  });
}
export async function saveAudienceObservation(prospectId: string, input: z.input<typeof audienceSchema>, client?: DbClient): Promise<LeadModel> {
  const a = audienceSchema.parse(input); const db = client ?? await getDb();
  return db.transaction(async tx => {
    await tx.query("LOCK TABLE prospects IN SHARE ROW EXCLUSIVE MODE");
    const lead = await lockedLead(tx, prospectId);
    if (!officialSource(a.accountUrl, lead) && !(a.officialLinkSourceUrl && officialSource(a.officialLinkSourceUrl, lead))) throw new AppError("The account needs an official business link.", 400, "unlinked_audience_account");
    const key = normalizeHandle(a.accountUrl, a.platform) ?? a.accountKey;
    const matches = await checkDuplicate({socialAccounts:[{platform:a.platform,url:a.accountUrl}]},tx);
    if (matches.some(match=>match.prospect.id!==prospectId)) throw new AppError("This social account belongs to an existing business.", 409, "duplicate_social_account");
    await append(tx, "prospect_audience_observations", { prospect_id: prospectId, platform: a.platform, account_key: key, handle: a.handle, account_url: a.accountUrl, count_value: a.countValue, count_state: a.countState, displayed_text: a.displayedText, is_approximate: a.isApproximate, checked_at: new Date(a.checkedAt).toISOString(), source_url: a.sourceUrl, official_link_source_url: a.officialLinkSourceUrl, engagement_signal: null, provenance_key: a.provenanceKey });
    return getLeadModel(prospectId, tx);
  });
}
export async function saveContactRoute(prospectId: string, input: z.input<typeof routeSchema>, client?: DbClient): Promise<LeadModel> {
  const r = routeSchema.parse(input); const db = client ?? await getDb();
  return db.transaction(async tx => {
    const lead = await lockedLead(tx, prospectId);
    if (r.officialStatus === "verified" && !officialSource(r.sourceUrl, lead) && !(r.officialLinkSourceUrl && officialSource(r.officialLinkSourceUrl, lead))) throw new AppError("Official contact routes need an official business source.", 400, "unlinked_contact_route");
    await append(tx, "prospect_contact_route_observations", { prospect_id: prospectId, platform: r.platform, route_kind: r.routeKind, handle: r.handle, route_url: r.routeUrl, official_status: r.officialStatus, checked_at: new Date(r.checkedAt).toISOString(), source_url: r.sourceUrl, official_link_source_url: r.officialLinkSourceUrl, notes: r.notes, provenance_key: r.provenanceKey });
    return getLeadModel(prospectId, tx);
  });
}
export async function getLeadModels(ids: string[], client?: DbClient): Promise<Map<string, LeadModel>> {
  const result = new Map(ids.map(id => [id, emptyLeadModel()])); if (!ids.length) return result;
  const db = client ?? await getDb();
  const assessments = (await db.query<Row>(`SELECT DISTINCT ON (prospect_id) * FROM prospect_assessments WHERE prospect_id=ANY($1::uuid[]) ORDER BY prospect_id,assessed_at DESC,created_at DESC,id DESC`, [ids])).rows;
  const overrides = (await db.query<Row>(`SELECT DISTINCT ON (prospect_id,field_name) * FROM prospect_assessment_overrides WHERE prospect_id=ANY($1::uuid[]) ORDER BY prospect_id,field_name,decided_at DESC,id DESC`, [ids])).rows;
  const audiences = (await db.query<Row>(`SELECT DISTINCT ON (prospect_id,platform,account_key) * FROM prospect_audience_observations WHERE prospect_id=ANY($1::uuid[]) ORDER BY prospect_id,platform,account_key,checked_at DESC,created_at DESC,id DESC`, [ids])).rows;
  const routes = (await db.query<Row>(`SELECT DISTINCT ON (prospect_id,platform,route_kind,coalesce(handle,''),coalesce(route_url,'')) * FROM prospect_contact_route_observations WHERE prospect_id=ANY($1::uuid[]) ORDER BY prospect_id,platform,route_kind,coalesce(handle,''),coalesce(route_url,''),checked_at DESC,id DESC`, [ids])).rows;
  for (const a of assessments) result.set(a.prospect_id, { ...result.get(a.prospect_id)!, assessmentId:a.id, tier:a.tier, eligibility:a.eligibility, exclusionReason:a.exclusion_reason, eligibilityChecks:json(a.eligibility_checks,{}), productFit:a.product_fit, platformMaturity:a.platform_maturity, mobileAppStatus:a.mobile_app_status, fitReasoning:a.fit_reasoning, capabilityGaps:json(a.capability_gaps,[]), findings:json(a.findings,[]), sourcesChecked:json(a.sources_checked,[]), missingInformation:json(a.missing_information,[]), researchConfidence:a.research_confidence, priorityScore:a.priority_score===null?null:Number(a.priority_score), priorityProvisional:a.priority_provisional, priorityComponents:json(a.priority_components,emptyLeadModel().priorityComponents), assessedAt:iso(a.assessed_at) });
  const fields: Record<string,string> = { eligibility:"eligibility",tier:"tier",platform_maturity:"platformMaturity",mobile_app_status:"mobileAppStatus",capability_gaps:"capabilityGaps",product_fit:"productFit",research_confidence:"researchConfidence",priority_score:"priorityScore" };
  for (const o of overrides) if (o.decision === "set") { const m = result.get(o.prospect_id)!; (m as unknown as Row)[fields[o.field_name]] = json(o.value, o.value); m.overriddenFields.push(o.field_name); }
  for (const a of audiences) result.get(a.prospect_id)!.audiences.push({ id:a.id, platform:a.platform, accountKey:a.account_key, handle:a.handle, accountUrl:a.account_url, countValue:a.count_value===null?null:Number(a.count_value), countState:a.count_state, checkedAt:iso(a.checked_at)!, sourceUrl:a.source_url, isApproximate:a.is_approximate, displayedText:a.displayed_text, officialLinkSourceUrl:a.official_link_source_url, provenanceKey:a.provenance_key });
  for (const r of routes) result.get(r.prospect_id)!.contactRoutes.push({ id:r.id,platform:r.platform,routeKind:r.route_kind,handle:r.handle,routeUrl:r.route_url,officialStatus:r.official_status,checkedAt:iso(r.checked_at)!,sourceUrl:r.source_url,officialLinkSourceUrl:r.official_link_source_url,notes:r.notes,provenanceKey:r.provenance_key });
  for (const m of result.values()) {
    m.priorityProvisional = m.productFit === "unknown";
    if (m.assessmentId && m.tier && m.tier !== "excluded") { m.priorityComponents = priorityFor(m, new Date(m.assessedAt!)); if (!m.overriddenFields.includes("priority_score")) m.priorityScore = totalPriority(m.priorityComponents); }
    if (m.eligibility === "excluded" || m.tier === "excluded") { m.tier="excluded"; m.priorityScore=null; }
  }
  return result;
}
export async function getLeadModel(id: string, db?: DbClient): Promise<LeadModel> { return (await getLeadModels([id],db)).get(id)!; }

export async function setAssessmentOverride(prospectId: string, input: { field: string; decision: "set" | "clear"; value?: unknown; reason: string; provenanceKey: string; actorUserId: string }): Promise<LeadModel> {
  const schemas: Record<string,z.ZodType> = { product_fit:z.enum(["high","medium","unknown","low"]), priority_score:z.number().int().min(0).max(100), research_confidence:z.enum(["unknown","low","medium","high"]), platform_maturity:z.enum(["unknown","fragmented","partial","integrated"]), mobile_app_status:z.enum(["unknown","verified_present","not_found_in_checked_sources","verified_absent"]), capability_gaps:z.array(findingSchema) };
  // Tier/eligibility reclassification requires a new evidence-backed assessment, not an override that
  // manufactures an email or paid service. The schema leaves historical founder decisions preservable.
  if (!schemas[input.field]) throw new AppError("Reassess eligibility/tier with evidence; this field is not a free-form override.",400,"invalid_assessment_override");
  const reason=z.string().trim().min(3).parse(input.reason), key=z.string().trim().min(1).parse(input.provenanceKey);
  const value=input.decision==="clear"?null:schemas[input.field].parse(input.value);
  const db=await getDb(); return db.transaction(async tx=>{
    const user=(await tx.query<{role:string}>("SELECT role FROM users WHERE id=$1 AND is_active=true",[input.actorUserId])).rows[0];
    if(user?.role!=="founder")throw new AppError("Only the founder may override an assessment.",403,"founder_required");
    await lockedLead(tx,prospectId);
    await append(tx,"prospect_assessment_overrides",{prospect_id:prospectId,field_name:input.field,decision:input.decision,value,reason,decided_by:input.actorUserId,provenance_key:key});
    return getLeadModel(prospectId,tx);
  });
}
