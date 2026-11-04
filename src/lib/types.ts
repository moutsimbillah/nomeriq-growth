export type Role = "founder" | "admin" | "member";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export type Category = "forex" | "metals" | "crypto" | "indices" | "commodities";

export const CATEGORIES: { value: Category; label: string; short: string }[] = [
  { value: "forex", label: "Forex", short: "FX" },
  { value: "metals", label: "Metals", short: "Metals" },
  { value: "crypto", label: "Cryptocurrency", short: "Crypto" },
  { value: "indices", label: "Indices", short: "Indices" },
  { value: "commodities", label: "Commodities", short: "Commodities" },
];

export const PIPELINE = [
  "new",
  "verified",
  "draft_prepared",
  "contacted",
  "replied",
  "interested",
  "demo",
  "proposal",
  "won",
  "lost",
] as const;

export type PipelineStatus = (typeof PIPELINE)[number];

export const PIPELINE_LABELS: Record<PipelineStatus, string> = {
  new: "New lead",
  verified: "Verified",
  draft_prepared: "Draft prepared",
  contacted: "Contacted",
  replied: "Replied",
  interested: "Interested",
  demo: "Demo / discussion",
  proposal: "Proposal / negotiation",
  won: "Won",
  lost: "Lost / not interested",
};

export const CLASSIFICATIONS = [
  "interested",
  "demo",
  "features",
  "pricing",
  "technical",
  "not_interested",
  "unsubscribe",
  "other",
] as const;

export type Classification = (typeof CLASSIFICATIONS)[number];

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  interested: "Interested",
  demo: "Requests demo",
  features: "Asks about features",
  pricing: "Asks about pricing",
  technical: "Technical question",
  not_interested: "Not interested",
  unsubscribe: "Unsubscribe / opt-out",
  other: "Other",
};

export interface ProductTruth {
  id: string;
  version: number;
  status: "needs_review" | "approved";
  oneLiner: string;
  offerSummary: string;
  howItWorks: string;
  pricingNotes: string;
  integrations: string;
  limitations: string;
  approvedClaims: string[];
  prohibitedClaims: string[];
  approvedAt: string | null;
  updatedAt: string;
}

/** Which agent produced a row, normalised. Reporting only — never read for permissions or trust. */
export type AgentTag =
  | "claude" | "chatgpt" | "gemini" | "hermes" | "deepseek" | "founder" | "other" | "unknown";

/** How it arrived: an OAuth connector, an API key, the research engine, or the portal itself. */
export type ChannelTag = "mcp_oauth" | "api_key" | "engine" | "founder";

export interface ProspectSummary {
  id: string;
  businessName: string;
  websiteUrl: string | null;
  domainKey: string | null;
  country: string | null;
  categories: Category[];
  qualificationStatus: "candidate" | "verified" | "rejected";
  status: PipelineStatus;
  contactEmail: string | null;
  contactEmailSource: string | null;
  verifiedAt: string | null;
  signalDescription: string | null;
  pricingDetails: string | null;
  instagramUrl: string | null;
  youtubeUrl: string | null;
  followerCount: string | null;
  subscriberCount: string | null;
  researchJobId: string | null;
  /** The connector that saved this lead, as it named itself. Reporting only. */
  sourceClient: string | null;
  sourceAgent: AgentTag | null;
  sourceChannel: ChannelTag | null;
  /** The agent that wrote the first-contact draft, when one exists. Shown as a difference marker. */
  firstDraftAgent?: AgentTag | null;
  nextAction: string | null;
  nextActionAt: string | null;
  lastContactedAt: string | null;
  lastReplyAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProspectDetail extends ProspectSummary {
  researchNotes: string | null;
  evidenceSummary: string | null;
  founderNotes: string | null;
  rejectionReason: string | null;
  xUrl: string | null;
  telegramUrl: string | null;
  linkedinUrl: string | null;
  otherSocials: { label: string; url: string }[];
  doNotContact: boolean;
  sources: ProspectSource[];
  emails: ProspectEmail[];
  aliases: string[];
}

export interface ProspectSource {
  id: string;
  url: string;
  label: string;
  sourceType: string;
  observedAt: string;
  notes: string | null;
}

export interface ProspectEmail {
  id: string;
  email: string;
  sourceUrl: string;
  sourceType: string;
  verifiedAt: string;
  isPrimary: boolean;
}

export interface Draft {
  id: string;
  prospectId: string;
  prospectName?: string;
  prospectEmail?: string;
  kind: "first_contact" | "follow_up";
  sequence: number;
  status: "draft" | "approved" | "sent" | "discarded" | "cancelled";
  subject: string;
  body: string;
  recipientEmail: string;
  aiGenerated: boolean;
  aiModel: string | null;
  /** The connector that saved this draft, as it named itself. Reporting only. */
  sourceClient: string | null;
  sourceAgent: AgentTag | null;
  sourceChannel: ChannelTag | null;
  productTruthVersion: number | null;
  warnings: DraftWarning[];
  founderEdited: boolean;
  approvedAt: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DraftWarning {
  code: string;
  message: string;
  severity: "warning" | "info";
}

export type ResearchEngine = "manual" | "deepseek";
export type ResearchJobStatus =
  | "active"
  | "paused"
  | "completed"
  | "archived"
  | "cancelled"
  | "failed"
  | "budget_paused";

export interface ResearchJob {
  id: string;
  name: string;
  targetCount: number;
  categories: Category[];
  regions: string;
  requirements: string;
  status: ResearchJobStatus;
  engine: ResearchEngine;
  notes: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  stoppedAt: string | null;
  lastWorkerAt: string | null;
  nextRunAt: string | null;
  stopReason: string | null;
  lastError: string | null;
  budgetUsd: number;
  spentUsd: number;
  concurrency: number;
  /** How many bounded worker steps have run. A stalled job shows a still count. */
  ticks: number;
  searchQueriesUsed: number;
  candidatesDiscovered: number;
  failedVerifications: number;
  candidatesPending: number;
  candidatesQualified: number;
  verifiedCount: number;
  emailCount: number;
  draftCount: number;
  duplicatesRejected: number;
  remaining: number;
}

export type ResearchCandidateStatus =
  | "pending"
  | "researching"
  | "qualified"
  | "duplicate"
  | "rejected"
  | "failed";

export interface ResearchCandidate {
  id: string;
  jobId: string;
  identityKey: string;
  businessName: string | null;
  websiteUrl: string | null;
  domainKey: string | null;
  sourceUrl: string | null;
  searchQuery: string | null;
  status: ResearchCandidateStatus;
  /** The claim this worker holds while researching, when one is held. */
  claimId?: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchUsageEntry {
  operation: "search" | "fetch" | "chat" | "draft";
  model: string | null;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  status: "success" | "error";
  createdAt: string | null;
}

export interface ResearchUsageSummary {
  costUsd: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  searches: number;
  fetches: number;
  modelCalls: number;
  recent: ResearchUsageEntry[];
}

export interface ResearchRunSummary {
  id: string;
  workerId: string;
  status: "running" | "completed" | "failed" | "interrupted" | "budget_paused" | "cancelled";
  startedAt: string;
  lastHeartbeatAt: string;
  endedAt: string | null;
  processed: number;
  saved: number;
  errors: number;
  stopReason: string | null;
}

export interface ResearchTickResult {
  jobId: string | null;
  status: string;
  processed: number;
  saved: number;
  duplicates: number;
  rejected: number;
  failed: number;
  searches: number;
  fetches: number;
  modelCalls: number;
  spentUsd: number;
  stopReason: string | null;
  notes: string[];
}

export interface CampaignSummary {
  id: string;
  name: string;
  status: string;
  accountEmail: string;
  total: number;
  sent: number;
  failed: number;
  queued: number;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  prospectId: string;
  prospectName: string;
  prospectEmail: string | null;
  subject: string;
  status: string;
  classification: Classification;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  unreadCount: number;
  snippet: string | null;
}

export interface Message {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  direction: "outbound" | "inbound";
  fromEmail: string;
  fromName: string | null;
  toEmails: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  snippet: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  isSandbox: boolean;
  deliveryStatus: string;
  attachments: {
    id?: string;
    filename: string;
    contentType: string;
    size: number;
  }[];
  source: string;
  external: boolean;
  draftId: string | null;
}
