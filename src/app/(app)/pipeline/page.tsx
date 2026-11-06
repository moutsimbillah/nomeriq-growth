import Link from "next/link";
import { BarChart3, Clock3, Mail, Users } from "lucide-react";
import { getPipelineBoard, listMarkets, PIPELINE_PAGE_SIZE, type PipelineCard, type PipelineColumnKey } from "@/lib/services/pipeline";
import { listEmailAccounts } from "@/lib/email/accounts";
import { defaultSenderLabel, senderLabels, senderShortName } from "@/lib/email/senderPill";
import { AGENT_LABELS } from "@/lib/agent/agentTag";
import { AgentPill, SenderPill } from "@/components/ui";
import { AutoFilters, CardMove, DraggableCard, DropColumn } from "@/components/pipeline-client";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/utils";
import { CATEGORIES } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The pipeline board (email item 5). Eight columns over all verified leads plus every
 * lead with conversation history, regardless of qualification; cards carry the tier slot, largest audience, sender, status line, follow-up status, last
 * activity and how long a reply has waited (red after 24 hours). Founder columns accept a drag or a
 * "Move to…" click through the audited stage endpoint; the automatic columns move from facts.
 */

type Params = Record<string, string | undefined>;

function boardHref(params: Params, change: Params): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...params, ...change })) {
    if (value) next.set(key, value);
  }
  const query = next.toString();
  return `/pipeline${query ? `?${query}` : ""}`;
}

export default async function PipelinePage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const limits: Partial<Record<PipelineColumnKey, number>> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith("n_") && value) limits[key.slice(2) as PipelineColumnKey] = Number.parseInt(value, 10);
  }
  const [board, accounts, markets] = await Promise.all([
    getPipelineBoard({ sender: params.sender, agent: params.agent, market: params.market, limits }),
    listEmailAccounts(),
    listMarkets(),
  ]);
  const labels = senderLabels(accounts);
  const defaultProfile = accounts.find((row) => row.isDefault) ?? accounts[0] ?? null;
  const senderPill = (id: string | null) =>
    id
      ? { id, label: labels.get(id) ?? senderShortName(accounts.find((a) => a.id === id) ?? {}) }
      : { id: null, label: defaultSenderLabel(defaultProfile) };
  const filterBase = { sender: params.sender, agent: params.agent, market: params.market };

  return (
    <div className="animate-fade-up" data-pipeline-board>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-12 font-bold uppercase tracking-[0.15em] text-faint">Pipeline</div>
          <h1 className="mt-1 text-28 font-bold leading-tight tracking-[-0.02em] text-ink">Where every lead stands</h1>
          <p className="mt-0.5 text-12 text-muted">
            {board.total} leads, each in one column (all conversation history included). Research to Engaged move by themselves from what was sent and
            received; Demo, Commercial, Won and Lost are yours — drag a card or use “Move to…”. Every move is recorded.
          </p>
        </div>
        <Link href="/pipeline/analytics" className="btn-secondary btn-sm"><BarChart3 size={12} /> Analytics</Link>
      </div>

      <div className="mb-3">
        <AutoFilters
          path="/pipeline"
          base={filterBase}
          selects={[
            { name: "tier", label: "Tier", disabled: true, note: "Reserved for the lead model", options: [{ value: "", label: "Tier: not recorded yet" }] },
            { name: "productFit", label: "Product fit", disabled: true, note: "Reserved for the lead model", options: [{ value: "", label: "Product fit: not recorded yet" }] },
            { name: "market", label: "Market", options: [{ value: "", label: "All markets" }, ...markets.map((m) => ({ value: m, label: m === "crypto" ? "Crypto" : CATEGORIES.find(c => c.value === m)?.label ?? m }))] },
            {
              name: "sender",
              label: "Sender",
              options: [
                { value: "", label: "All senders" },
                ...accounts.map((a) => ({ value: a.id, label: labels.get(a.id) ?? a.emailAddress })),
                { value: "none", label: "No sender yet" },
              ],
            },
            { name: "agent", label: "Agent", options: [{ value: "", label: "All agents" }, ...Object.entries(AGENT_LABELS).map(([k, l]) => ({ value: k, label: l }))] },
          ]}
        />
      </div>

      <div className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-3" data-columns>
        {board.columns.map((column) => (
          <section key={column.key} className="w-[232px] shrink-0 snap-start rounded-xl border border-line bg-white/40" data-column={column.key}>
            <header className="flex items-start justify-between gap-2 border-b border-line px-3 py-2.5">
              <div>
                <h2 className="text-13 font-bold text-ink">{column.label}</h2>
                <p className="text-12 text-faint">{column.hint}</p>
              </div>
              <span className={cn("rounded-full px-2 py-0.5 text-12 font-bold tabular-nums", column.stage ? "bg-forest text-lime" : "bg-ink/[0.06] text-muted")} data-column-count>
                {column.count}
              </span>
            </header>
            <DropColumn stage={column.stage}>
              {column.cards.length === 0 && <p className="px-2 py-6 text-center text-12 text-faint">No leads</p>}
              {column.cards.map((card) => (
                <DraggableCard key={card.prospectId} prospectId={card.prospectId}>
                  <BoardCard card={card} sender={senderPill(card.sendingProfileId)} />
                </DraggableCard>
              ))}
              {column.hasMore && (
                <div className="pt-1 text-center">
                  <Link href={boardHref(params, { [`n_${column.key}`]: String(column.limit + PIPELINE_PAGE_SIZE) })} className="btn-secondary btn-xs" scroll={false}>
                    Load more ({column.count - column.cards.length})
                  </Link>
                </div>
              )}
            </DropColumn>
          </section>
        ))}
      </div>
    </div>
  );
}

function BoardCard({ card, sender }: { card: PipelineCard; sender: { id: string | null; label: string | null } }) {
  const waitedMs = card.replyWaitingSince ? Date.now() - Date.parse(card.replyWaitingSince) : 0;
  const overDay = waitedMs > 86_400_000;
  return (
    <article className="rounded-lg border border-line bg-white p-2.5 shadow-[0_1px_0_rgba(0,0,0,0.03)]" data-card={card.prospectId}>
      <div className="flex items-start justify-between gap-2">
        <Link href={`/leads/${card.prospectId}`} title={card.businessName} data-card-name className="min-w-0 line-clamp-2 break-anywhere text-13 font-bold text-ink hover:underline">{card.businessName}</Link>
        <span className="shrink-0 text-12 text-faint" title="Last activity">{card.lastActivityAt ? relativeTime(card.lastActivityAt) : ""}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className="badge text-faint" title="Tier is not recorded yet" data-tier>{card.tier ?? "Tier —"}</span>
        {card.audience && <span className="badge" title="Largest audience"><Users size={10} /> {card.audience}</span>}
        <SenderPill profile={sender} />
      </div>
      <p className={cn("mt-1.5 text-12 font-semibold leading-4", card.replyWaitingSince ? "text-ink" : "text-muted")} data-status-line>{card.statusLine}</p>
      {card.followUpLine && <p className="mt-0.5 text-12 leading-4 text-faint" data-follow-up-line>{card.followUpLine}</p>}
      {card.replyWaitingSince && (
        <span className={cn("badge mt-1.5", overDay ? "border-rust/30 bg-rust/[0.06] text-rust" : "")} data-reply-wait>
          <Clock3 size={10} /> waiting {relativeTime(card.replyWaitingSince).replace(/ ago$/, "")}
        </span>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-1.5 border-t border-line pt-2">
        <AgentPill agent={card.sourceAgent ?? "unknown"} channel={card.sourceChannel} note={card.sourceAgent === "other" ? card.sourceClient : undefined} />
        <div className="ml-auto flex items-center gap-1">
          <Link href={`/email?c=${card.prospectId}`} className="grid h-7 w-7 place-items-center rounded-md border border-line text-muted hover:text-ink" title="Open in Email" aria-label="Open in Email">
            <Mail size={12} />
          </Link>
          <CardMove prospectId={card.prospectId} status={card.status} />
        </div>
      </div>
    </article>
  );
}
