import {
  asStringArray,
  iso,
  json,
  number,
} from "@/lib/utils";
import type {
  Category,
  Classification,
  Draft,
  DraftWarning,
  PipelineStatus,
  ProspectDetail,
  ProspectEmail,
  ProspectSource,
  ProspectSummary,
  ProductTruth,
  ResearchCandidate,
} from "@/lib/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export function mapProspect(row: any): ProspectSummary {
  return {
    id: row.id,
    businessName: row.business_name,
    websiteUrl: row.website_url,
    domainKey: row.domain_key,
    country: row.country,
    categories: asStringArray(row.categories) as Category[],
    qualificationStatus: row.qualification_status,
    status: row.status as PipelineStatus,
    contactEmail: row.contact_email ?? row.primary_email ?? null,
    contactEmailSource:
      row.contact_email_source ?? row.primary_email_source ?? null,
    verifiedAt: iso(row.verified_at),
    signalDescription: row.signal_description,
    pricingDetails: row.pricing_details,
    instagramUrl: row.instagram_url,
    youtubeUrl: row.youtube_url,
    followerCount: row.follower_count,
    subscriberCount: row.subscriber_count,
    researchJobId: row.research_job_id,
    sourceClient: row.source_client ?? null,
    nextAction: row.next_action,
    nextActionAt: iso(row.next_action_at),
    lastContactedAt: iso(row.last_contacted_at),
    lastReplyAt: iso(row.last_reply_at),
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
  };
}

export function mapProspectDetail(
  row: any,
  sources: ProspectSource[] = [],
  emails: ProspectEmail[] = [],
  aliases: string[] = [],
): ProspectDetail {
  return {
    ...mapProspect(row),
    researchNotes: row.research_notes,
    evidenceSummary: row.evidence_summary,
    founderNotes: row.founder_notes,
    rejectionReason: row.rejection_reason,
    xUrl: row.x_url,
    telegramUrl: row.telegram_url,
    linkedinUrl: row.linkedin_url,
    otherSocials: json(row.other_socials, []),
    doNotContact: Boolean(row.do_not_contact),
    sources,
    emails,
    aliases,
  };
}

export function mapSource(row: any): ProspectSource {
  return {
    id: row.id,
    url: row.url,
    label: row.label,
    sourceType: row.source_type,
    observedAt: iso(row.observed_at) ?? new Date().toISOString(),
    notes: row.notes,
  };
}

export function mapEmail(row: any): ProspectEmail {
  return {
    id: row.id,
    email: row.email,
    sourceUrl: row.source_url,
    sourceType: row.source_type,
    verifiedAt: iso(row.verified_at) ?? new Date().toISOString(),
    isPrimary: Boolean(row.is_primary),
  };
}

export function mapDraft(row: any): Draft {
  return {
    id: row.id,
    prospectId: row.prospect_id,
    prospectName: row.prospect_name,
    prospectEmail: row.prospect_email,
    kind: row.kind,
    sequence: number(row.sequence),
    status: row.status,
    subject: row.subject,
    body: row.body,
    recipientEmail: row.recipient_email,
    aiGenerated: Boolean(row.ai_generated),
    aiModel: row.ai_model,
    sourceClient: row.source_client ?? null,
    productTruthVersion: row.product_truth_version
      ? number(row.product_truth_version)
      : null,
    warnings: json<DraftWarning[]>(row.warnings, []),
    founderEdited: Boolean(row.founder_edited),
    approvedAt: iso(row.approved_at),
    sentAt: iso(row.sent_at),
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
  };
}

export function mapProductTruth(row: any): ProductTruth {
  return {
    id: row.id,
    version: number(row.version),
    status: row.status,
    oneLiner: row.one_liner,
    offerSummary: row.offer_summary,
    howItWorks: row.how_it_works,
    pricingNotes: row.pricing_notes,
    integrations: row.integrations,
    limitations: row.limitations,
    approvedClaims: asStringArray(row.approved_claims),
    prohibitedClaims: asStringArray(row.prohibited_claims),
    approvedAt: iso(row.approved_at),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
  };
}

export function mapClassification(value: string): Classification {
  return value as Classification;
}

export function mapResearchCandidate(row: any): ResearchCandidate {
  return {
    id: row.id,
    jobId: row.job_id,
    identityKey: row.identity_key,
    businessName: row.business_name,
    websiteUrl: row.website_url,
    domainKey: row.domain_key,
    sourceUrl: row.source_url,
    searchQuery: row.search_query,
    status: row.status,
    attempts: number(row.attempts),
    lastError: row.last_error,
    createdAt: iso(row.created_at) ?? new Date().toISOString(),
    updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
  };
}
