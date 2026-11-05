import Link from "next/link";
import type { ReactNode } from "react";
import { agentProvenance } from "@/lib/agent/agentTag";
import {
  AGENT_PILL_A,
  AGENT_PILL_A_MARK,
  AGENT_PILL_B,
  AGENT_PILL_B_STRIPE,
  AGENT_PILL_BASE,
  AGENT_PILL_SIZE,
  AGENT_PILL_VARIANT,
  agentInitial,
  agentPillLabel,
  type AgentPillVariant,
} from "@/lib/agent/agentPill";
import {
  SENDER_PILL_CLASS,
  SENDER_PILL_SIZE,
  senderDotClass,
  senderPillLabel,
} from "@/lib/email/senderPill";
import type { AgentTag, ChannelTag } from "@/lib/types";
import {
  ArrowUpRight,
  CircleAlert,
  Inbox,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/cn";
import {
  CATEGORIES,
  PIPELINE_LABELS,
  type Category,
  type PipelineStatus,
} from "@/lib/types";

export function PageHeader({
  eyebrow,
  title,
  titleAside,
  description,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  /** Rendered beside the title but OUTSIDE the h1, so it never inherits the display serif or its tracking. */
  titleAside?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        {eyebrow && <div className="eyebrow mb-2.5">{eyebrow}</div>}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="display-title text-display sm:text-display-lg">{title}</h1>
          {titleAside}
        </div>
        {description && (
          <p className="mt-3 max-w-xl text-13 leading-6 text-muted">
            {description}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

export function SectionHeading({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div>
        <h2 className="text-16 font-bold tracking-[-0.01em] text-ink">
          {title}
        </h2>
        {description && (
          <p className="mt-0.5 text-12 leading-5 text-muted">
            {description}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

export function Card({
  children,
  className,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article";
}) {
  const Component = as;
  return <Component className={cn("card", className)}>{children}</Component>;
}

const STATUS_STYLES: Record<PipelineStatus, string> = {
  new: "border-line bg-white text-muted",
  verified: "border-blue/20 bg-blue/[0.07] text-blue",
  draft_prepared: "border-amber/20 bg-amber/[0.08] text-amber",
  contacted: "border-forest/15 bg-forest/[0.05] text-forest",
  replied: "border-amber/25 bg-amber/[0.1] text-amber",
  interested: "border-lime/50 bg-lime/40 text-forest",
  demo: "border-forest/25 bg-forest/[0.08] text-forest",
  proposal: "border-forest/25 bg-forest/[0.12] text-forest",
  won: "border-forest bg-forest text-lime",
  lost: "border-rust/20 bg-rust/[0.06] text-rust",
};

export function StatusBadge({
  status,
  className,
}: {
  status: PipelineStatus;
  className?: string;
}) {
  return (
    <span className={cn("pill whitespace-nowrap", STATUS_STYLES[status], className)}>
      {/* a stage is a soft pastel with a dot — never a filled badge, so it cannot read as an agent */}
      <span className="badge-dot shrink-0" />
      {PIPELINE_LABELS[status]}
    </span>
  );
}

/**
 * Markets are neutral by design: a grey outline for every one of them. They carry no coloured fill, so
 * no market pill can ever be mistaken for an agent pill, and the agent palette owns the only saturated
 * colours on a row.
 */
const CATEGORY_STYLES: Record<Category, string> = {
  forex: "border-line-strong bg-white/60 text-muted",
  metals: "border-line-strong bg-white/60 text-muted",
  crypto: "border-line-strong bg-white/60 text-muted",
  indices: "border-line-strong bg-white/60 text-muted",
  commodities: "border-line-strong bg-white/60 text-muted",
};

export function CategoryPill({ category }: { category: Category }) {
  const meta = CATEGORIES.find((item) => item.value === category);
  return (
    <span className={cn("pill", CATEGORY_STYLES[category])}>
      {meta?.label ?? category}
    </span>
  );
}

export function CategoryList({
  categories,
  limit,
}: {
  categories: Category[];
  limit?: number;
}) {
  const visible = limit ? categories.slice(0, limit) : categories;
  const rest = categories.length - visible.length;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((category) => (
        <CategoryPill key={category} category={category} />
      ))}
      {rest > 0 && (
        <span className="text-12 font-semibold text-faint">+{rest}</span>
      )}
    </div>
  );
}

export function Metric({
  label,
  value,
  hint,
  accent,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  accent?: "lime" | "rust" | "amber" | "forest";
  icon?: ReactNode;
}) {
  const accents = {
    lime: "bg-lime/70",
    rust: "bg-rust/60",
    amber: "bg-amber/60",
    forest: "bg-forest/80",
  };
  return (
    <Card className="relative overflow-hidden p-5">
      {accent && (
        <span
          className={cn(
            "absolute right-5 top-5 h-1.5 w-1.5 rounded-full",
            accents[accent],
          )}
        />
      )}
      <div className="flex items-center gap-2 text-12 font-bold uppercase tracking-[0.13em] text-faint">
        {icon}
        {label}
      </div>
      <div className="stat-value mt-3">{value}</div>
      {hint && <div className="mt-2 text-12 text-muted">{hint}</div>}
    </Card>
  );
}

export function ProgressBar({
  value,
  max,
  className,
  tone = "forest",
}: {
  value: number;
  max: number;
  className?: string;
  tone?: "forest" | "lime" | "amber";
}) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const tones = {
    forest: "bg-forest",
    lime: "bg-[#a8d846]",
    amber: "bg-amber",
  };
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-ink/[0.07]", className)}>
      <div
        className={cn("h-full rounded-full transition-all duration-500", tones[tone])}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: {
  title: string;
  description?: string;
  icon?: "inbox" | "sparkles" | "alert";
  action?: ReactNode;
  className?: string;
}) {
  const Icon =
    icon === "sparkles" ? Sparkles : icon === "alert" ? CircleAlert : Inbox;
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-6 py-12 text-center",
        className,
      )}
    >
      <div className="mb-4 grid h-11 w-11 place-items-center rounded-full border border-line bg-white/60 text-muted">
        <Icon size={17} strokeWidth={1.7} />
      </div>
      <div className="text-13 font-semibold text-ink">{title}</div>
      {description && (
        <p className="mt-1.5 max-w-sm text-12 leading-5 text-muted">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Notice({
  children,
  tone = "info",
  title,
  action,
}: {
  children: ReactNode;
  tone?: "info" | "warning" | "danger" | "success" | "sandbox";
  title?: string;
  action?: ReactNode;
}) {
  const tones = {
    info: "border-line bg-white/50 text-muted",
    warning: "border-amber/25 bg-amber/[0.06] text-[#76501a]",
    danger: "border-rust/25 bg-rust/[0.05] text-rust",
    success: "border-forest/20 bg-forest/[0.045] text-forest",
    sandbox: "border-forest/20 bg-lime/20 text-forest",
  };
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border px-4 py-3 text-12 leading-5 sm:flex-row sm:items-center sm:justify-between",
        tones[tone],
      )}
    >
      <div>
        {title && <span className="mr-1.5 font-bold">{title}</span>}
        {children}
      </div>
      {action}
    </div>
  );
}

export function ExternalLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn("link inline-flex items-center gap-1", className)}
    >
      {children}
      <ArrowUpRight size={11} strokeWidth={2.2} />
    </a>
  );
}

export function Avatar({
  name,
  size = "md",
}: {
  name: string;
  size?: "sm" | "md" | "lg";
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
  const sizes = {
    sm: "h-7 w-7 text-12",
    md: "h-9 w-9 text-12",
    lg: "h-11 w-11 text-12",
  };
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-forest font-bold tracking-wide text-lime",
        sizes[size],
      )}
    >
      {initials || "N"}
    </span>
  );
}

/**
 * Where a lead or draft came from. The tooltip says how trustworthy the value is: an API key's label
 * is set by the founder, a connector's name is only what the connector called itself.
 */
/**
 * The quietest pill family: which mailbox a lead is emailed from. An outline with a small coloured dot,
 * not a filled badge — the sender is context, not a claim about who did the work — and it always spells
 * the profile's name, so it never relies on colour.
 *
 * A lead with no profile yet has no sender of its own, and the caller spells that out — `NO_SENDER_LABEL`,
 * "No sender yet" — rather than naming a mailbox the lead was never assigned.
 */
export function SenderPill({
  profile,
  size = "md",
  className,
  title,
}: {
  profile: { id: string | null; label: string | null } | null;
  size?: "md" | "lg";
  className?: string;
  /** The full address and the profile's own name, for the tooltip. */
  title?: string;
}) {
  const label = senderPillLabel(profile);
  const tooltip =
    title ??
    (profile?.id
      ? `Sending profile: ${label}`
      : "No sending profile yet — pick the mailbox this lead is sent from");
  return (
    <span
      title={tooltip}
      data-sender={profile?.id ?? "default"}
      className={cn(SENDER_PILL_CLASS, SENDER_PILL_SIZE[size], className)}
    >
      <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", senderDotClass(profile?.id ?? null))} />
      {/* Wraps rather than ellipsises: at a narrow width a domain must not become "nomeri…", so the
          label keeps as many lines as it needs. The agent pill keeps its ellipsis — a 290-character
          connector name is a different problem. */}
      <span className="min-w-0 whitespace-normal break-words text-left">{label}</span>
    </span>
  );
}

export function AgentPill({
  agent,
  channel,
  note,
  size = "md",
  variant = AGENT_PILL_VARIANT,
  className,
}: {
  agent: AgentTag | null;
  channel: ChannelTag | null;
  note?: string | null;
  size?: "md" | "lg";
  /** "A" solid, "B" striped card. Fixed app-wide; the preview page renders both for comparison. */
  variant?: AgentPillVariant;
  className?: string;
}) {
  if (!agent && !channel) return null;
  const tag = agent ?? "unknown";
  const provenance = agentProvenance(agent ?? null, channel ?? null);
  const tooltip = note ? `${provenance} — declared name: ${note}` : provenance;
  const label = agentPillLabel(agent ?? "unknown", note);

  if (variant === "B") {
    return (
      <span
        title={tooltip}
        className={cn(
          AGENT_PILL_BASE,
          AGENT_PILL_SIZE[size],
          AGENT_PILL_B[tag],
          "pl-0",
          className,
        )}
      >
        {/* the 2px stripe is decoration; the name beside it is the message */}
        <span className={cn("mr-1.5 h-full w-[2px] shrink-0 self-stretch", AGENT_PILL_B_STRIPE[tag])} />
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", AGENT_PILL_B_STRIPE[tag])} />
        <span className="truncate">{label}</span>
      </span>
    );
  }

  return (
    <span
      title={tooltip}
      className={cn(AGENT_PILL_BASE, AGENT_PILL_SIZE[size], AGENT_PILL_A[tag], className)}
    >
      {/* the initial on a disc of the agent's full colour: a status pill has a plain dot, so the two
          can never be mistaken for each other, and the name is always text beside it */}
      <span
        aria-hidden
        className={cn(
          "grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full text-12 font-bold leading-none text-white",
          AGENT_PILL_A_MARK[tag],
        )}
      >
        {agentInitial(tag)}
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
}

export function DataRow({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[116px_1fr] gap-3 border-b border-line/70 py-2.5 last:border-b-0",
        className,
      )}
    >
      <dt className="text-12 font-semibold uppercase tracking-[0.08em] text-faint">
        {label}
      </dt>
      <dd className="wrap-anywhere min-w-0 text-12 leading-5 text-ink">{children}</dd>
    </div>
  );
}

export function Tabs({
  tabs,
  active,
}: {
  tabs: { href: string; label: string; count?: number }[];
  active: string;
}) {
  return (
    <div className="scrollbar-thin flex gap-1 overflow-x-auto border-b border-line pb-px">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className={cn(
            "relative shrink-0 px-3.5 py-2.5 text-12 font-semibold text-muted transition hover:text-ink",
            active === tab.label && "text-ink",
          )}
        >
          {tab.label}
          {typeof tab.count === "number" && tab.count > 0 && (
            <span className="ml-1.5 rounded-full bg-ink/[0.06] px-1.5 py-0.5 text-12 font-bold text-muted">
              {tab.count}
            </span>
          )}
          {active === tab.label && (
            <span className="absolute inset-x-2 bottom-[-1px] h-[2px] rounded-full bg-forest" />
          )}
        </Link>
      ))}
    </div>
  );
}

export function KeyValue({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div>
      <div className="text-12 font-bold uppercase tracking-[0.12em] text-faint">
        {label}
      </div>
      <div className="mt-0.5 text-12 text-ink">{value}</div>
    </div>
  );
}
