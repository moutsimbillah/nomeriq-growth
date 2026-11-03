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

export interface ResearchJob {
  id: string;
  name: string;
  targetCount: number;
  categories: Category[];
  regions: string;
  requirements: string;
  status: "active" | "paused" | "completed" | "archived";
  notes: string;
  createdAt: string;
  completedAt: string | null;
  verifiedCount: number;
  emailCount: number;
  draftCount: number;
  duplicatesRejected: number;
  remaining: number;
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
