import { Camera, ExternalLink, MonitorPlay, Send } from "lucide-react";

/** Presentation only. Assessment/qualification decisions live in the shared lead-model service. */
export interface LeadQualificationView {
  tier: "tier_1" | "other" | "email_no_website" | "category_b" | "excluded" | null;
  productFit: "high" | "medium" | "low" | "unknown";
  platformMaturity: string;
  mobileAppStatus: string;
  fitReasoning: string;
  priorityScore: number | null;
  priorityProvisional: boolean;
  researchConfidence: string;
  assessedAt: string | null;
  overriddenFields: string[];
  capabilityGaps: { summary: string; sourceUrl: string; observedAt: string }[];
  findings: { area?: string; summary: string; sourceUrl: string; observedAt: string }[];
  missingInformation: string[];
  audiences: {
    id: string;
    platform: "instagram" | "youtube" | "telegram";
    accountKey: string;
    handle: string | null;
    accountUrl: string;
    countValue: number | null;
    countState: string;
    checkedAt: string;
    sourceUrl: string;
    isApproximate: boolean;
  }[];
  contactRoutes: {
    platform: string;
    routeKind: string;
    handle: string | null;
    routeUrl: string | null;
    officialStatus: string;
    checkedAt: string;
    sourceUrl: string;
  }[];
}

const tierStyle = {
  tier_1: ["Tier 1", "border-emerald-700/25 bg-emerald-50 text-emerald-800", "Priority provider: paid signals, official website and published business email, with an established Instagram or YouTube account."],
  other: ["Other", "border-sky-700/25 bg-sky-50 text-sky-800", "Verified signal provider with an official website and published business email; established Instagram or YouTube reach is not verified."],
  email_no_website: ["Email no website", "border-violet-700/25 bg-violet-50 text-violet-800", "Verified paid signal seller with an officially published email, but no official website. Eligible for founder-reviewed outreach; not counted towards qualified-lead targets."],
  category_b: ["Category B", "border-amber-700/25 bg-amber-50 text-amber-800", "Alternative contact only. Kept for research; never emailed and never counted towards email-qualified targets."],
  excluded: ["Excluded", "border-rose-700/25 bg-rose-50 text-rose-800", "Does not meet signal-seller requirements. Retained with its reason so it is not researched again."],
} as const;
const fitStyle = {
  high: ["High fit", "border-emerald-700/25 bg-emerald-50 text-emerald-800"],
  medium: ["Medium fit", "border-sky-700/25 bg-sky-50 text-sky-800"],
  unknown: ["Unknown fit", "border-slate-400/35 bg-slate-50 text-slate-600"],
  low: ["Low fit", "border-stone-400/35 bg-stone-100 text-stone-600"],
} as const;
const pill = "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-12 font-semibold leading-5";

function dateLabel(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "date unknown";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(value));
}

/** Compact rendering never supplies a number when the underlying count is Unknown. */
export function audienceCountLabel(count: number | null, approximate = false): string {
  if (count === null || !Number.isSafeInteger(count) || count < 0) return "Unknown";
  if (count < 1_000) return `${approximate ? "~" : ""}${count}`;
  const abbreviated = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(count);
  return `~${abbreviated}`;
}

export function TierPill({ tier }: { tier: LeadQualificationView["tier"] }) {
  if (!tier) return <span className={`${pill} border-line bg-paper text-faint`} title="No evidence-backed tier has been saved. Existing leads are not reclassified from missing information.">Unassessed</span>;
  const [label, style, title] = tierStyle[tier];
  return <span className={`${pill} ${style}`} title={title} data-lead-tier={tier}>{label}</span>;
}

export function ProductFitPill({ fit, overridden = false }: { fit: LeadQualificationView["productFit"]; overridden?: boolean }) {
  const [label, style] = fitStyle[fit];
  return <span className={`${pill} ${style}`} data-product-fit={fit} title={`${fit === "unknown" ? "Insufficient technology evidence — research needed, not Low fit." : "Need for Nomeriq, separate from eligibility and audience."}${overridden ? " Founder override takes precedence." : ""}`}>{label}{overridden && <span aria-label="Founder override">*</span>}</span>;
}

export function AudiencePills({ accounts }: { accounts: LeadQualificationView["audiences"] }) {
  if (!accounts.length) return <span className="text-12 text-faint">Audience unknown</span>;
  return <div className="flex flex-wrap gap-1" data-audience-accounts>
    {accounts.map((account) => {
      const Icon = account.platform === "instagram" ? Camera : account.platform === "youtube" ? MonitorPlay : Send;
      const count = account.countState === "verified" ? account.countValue : null;
      return <a key={account.id} className={`${pill} min-w-0 border-line bg-paper/70 text-muted hover:border-ink/30`} href={safePublicLink(account.accountUrl)} target="_blank" rel="noreferrer noopener" title={`${account.platform} · ${account.handle || account.accountKey} · ${count === null ? "Count unavailable" : `${count.toLocaleString("en")} ${account.isApproximate ? "(published approximate count)" : "verified"}`} · Checked ${dateLabel(account.checkedAt)} · ${account.sourceUrl}`}>
        <Icon size={11} className="shrink-0" aria-label={account.platform} />
        <span className="max-w-[130px] truncate">{account.handle || account.accountKey}</span>
        <span className="shrink-0 font-bold">{audienceCountLabel(count, account.isApproximate)}</span>
      </a>;
    })}
  </div>;
}

export function PriorityLabel({ model }: { model: LeadQualificationView }) {
  return <span className={`inline-flex flex-col text-12 ${model.productFit === "high" ? "font-bold text-emerald-800" : "text-muted"}`} title={model.priorityScore === null ? "No priority assessment yet; no score has been invented." : `Overall priority out of 100${model.priorityProvisional ? " · provisional, fit needs research" : ""}${model.overriddenFields.includes("priority_score") ? " · founder override" : ""}`} data-priority-score={model.priorityScore ?? "unknown"}>
    <span>{model.priorityScore === null ? "—" : `${model.priorityScore}/100`}</span>
    {model.priorityProvisional && model.priorityScore !== null && <span className="text-12 font-normal text-faint">provisional</span>}
  </span>;
}

export function LeadQualificationPills({ model }: { model: LeadQualificationView }) {
  return <span className="flex flex-wrap items-center gap-1" data-lead-qualification>
    <TierPill tier={model.tier} />
    <ProductFitPill fit={model.productFit} overridden={model.overriddenFields.includes("product_fit")} />
  </span>;
}

/** Defensive URL rendering: outside evidence is data, never an executable browser scheme. */
function safePublicLink(value: string): string | undefined {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}

export function ProductFitPanel({ model }: { model: LeadQualificationView }) {
  const maturity: Record<string, string> = { unknown: "Unknown", fragmented: "Fragmented tools", partial: "Partial infrastructure", integrated: "Integrated proprietary platform" };
  const app: Record<string, string> = { unknown: "Unknown — not sufficiently investigated", verified_present: "Branded app verified", not_found_in_checked_sources: "Not found in checked sources — absence not proven", verified_absent: "Confirmed absent by official evidence" };
  const setupAreas = new Set(["delivery", "membership", "dashboard", "publishing", "performance", "payments", "app", "gap"]);
  const setupFindings = model.findings.filter(item => !item.area || setupAreas.has(item.area));
  const evidence = [...model.capabilityGaps, ...setupFindings].filter((item, index, all) => all.findIndex(other => other.summary === item.summary && other.sourceUrl === item.sourceUrl) === index);
  return <section className="rounded-2xl border border-line bg-panel p-5" aria-label="Product fit" data-product-fit-panel>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-16 font-bold text-ink">Why Nomeriq may be needed</h2>
      <div className="flex items-center gap-2"><ProductFitPill fit={model.productFit} overridden={model.overriddenFields.includes("product_fit")} /><PriorityLabel model={model} /></div>
    </div>
    <dl className="mt-3 grid gap-3 text-12 sm:grid-cols-2">
      <div><dt className="font-semibold text-faint">Platform maturity</dt><dd className="mt-1 text-ink">{maturity[model.platformMaturity] ?? "Unknown"}</dd></div>
      <div><dt className="font-semibold text-faint">Mobile app</dt><dd className="mt-1 text-ink">{app[model.mobileAppStatus] ?? "Unknown"}</dd></div>
    </dl>
    <p className="mt-3 text-13 leading-6 text-muted">{model.fitReasoning || "The existing software and signal-delivery setup has not been investigated sufficiently. No platform gap is assumed."}</p>
    {evidence.length > 0 && <ul className="mt-3 space-y-2 text-12 text-muted">{evidence.map((item, index) => <li key={`${item.sourceUrl}-${index}`} className="rounded-lg border border-line bg-paper/50 p-2.5">
      <p>{item.summary}</p>
      <a href={safePublicLink(item.sourceUrl)} target="_blank" rel="noreferrer noopener" className="mt-1 inline-flex max-w-full items-center gap-1 break-all text-forest underline underline-offset-2"><ExternalLink size={10} className="shrink-0" />{item.sourceUrl}</a>
      <span className="mt-1 block text-faint">Checked {dateLabel(item.observedAt)}</span>
    </li>)}</ul>}
    <div className="mt-3 border-t border-line pt-3 text-12">
      <h3 className="font-semibold text-ink">Still missing</h3>
      <ul className="mt-1 list-inside list-disc text-muted">{(model.missingInformation.length ? model.missingInformation : model.assessedAt ? ["No additional gaps recorded in this assessment."] : ["Delivery method, subscriber tools, branded app status and evidence-supported capability gaps."]).map(item => <li key={item}>{item}</li>)}</ul>
      <p className="mt-2 text-faint">Research confidence: {model.researchConfidence} · {model.assessedAt ? `Assessed ${dateLabel(model.assessedAt)}` : "Not assessed"}{model.overriddenFields.length ? " · Founder override preserved" : ""}</p>
    </div>
  </section>;
}

export function ContactRoutes({ routes }: { routes: LeadQualificationView["contactRoutes"] }) {
  return <section className="rounded-2xl border border-line bg-panel p-5" aria-label="Alternative contact routes">
    <h2 className="text-16 font-bold text-ink">Contact routes</h2>
    <p className="mt-1 text-12 text-faint">Research records only. Growth does not send DMs or submit forms.</p>
    {routes.length ? <ul className="mt-3 space-y-2 text-12">{routes.map((route, index) => <li key={`${route.platform}-${index}`} className="break-words">
      <span className="font-semibold text-ink">{route.platform} · {route.routeKind}</span>{" — "}
      <a href={safePublicLink(route.routeUrl || route.sourceUrl)} target="_blank" rel="noreferrer noopener" className="text-forest underline">{route.handle || route.routeUrl || route.sourceUrl}</a>
      <span className="mt-0.5 block text-faint">{route.officialStatus === "verified" ? "Official source verified" : "Official status not verified"} · Checked {dateLabel(route.checkedAt)}</span>
    </li>)}</ul> : <p className="mt-3 text-12 text-muted">No dated routes recorded yet.</p>}
  </section>;
}
