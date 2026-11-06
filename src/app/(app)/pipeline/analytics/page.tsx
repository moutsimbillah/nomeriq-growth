import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getPipelineAnalytics, type RateRow } from "@/lib/services/pipeline-analytics";
import { listMarkets } from "@/lib/services/pipeline";
import { listEmailAccounts } from "@/lib/email/accounts";
import { senderLabels } from "@/lib/email/senderPill";
import { AGENT_LABELS } from "@/lib/agent/agentTag";
import { getWorkspaceSettings } from "@/lib/services/settings";
import { Card } from "@/components/ui";
import { AutoFilters } from "@/components/pipeline-client";
import { formatDate, relativeTime } from "@/lib/utils";
import { CATEGORIES } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Pipeline analytics (email item 5): one page, per week, filterable by market, sender
 * and agent; the tier filter waits for tier to be recorded. Every figure is counted from recorded
 * events. Small samples are shown as counts beside the percentage, so 1 of 2 never reads as "50%".
 */

type Params = Record<string, string | undefined>;

const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);
const hours = (value: number | null) =>
  value === null ? "—" : value < 1 ? `${Math.max(1, Math.round(value * 60))} min` : value < 48 ? `${value.toFixed(value < 10 ? 1 : 0)} h` : `${(value / 24).toFixed(1)} days`;

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <Card className="min-w-0 p-4">
      <h2 className="text-13 font-bold text-ink">{title}</h2>
      {note && <p className="mt-0.5 text-12 text-faint">{note}</p>}
      <div className="mt-3">{children}</div>
    </Card>
  );
}

function RateTable({ rows, label }: { rows: { name: string; row: RateRow }[]; label: string }) {
  if (!rows.length) return <p className="text-12 text-faint">No contacted leads in this view.</p>;
  return (
    <table className="w-full text-12">
      <thead>
        <tr className="text-left text-faint">
          <th className="pb-1.5 font-semibold">{label}</th>
          <th className="pb-1.5 text-right font-semibold">Contacted</th>
          <th className="pb-1.5 text-right font-semibold">Replied</th>
          <th className="pb-1.5 text-right font-semibold">Demo+</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {rows.map(({ name, row }) => (
          <tr key={row.key}>
            <td className="max-w-[160px] truncate py-1.5 font-semibold text-ink">{name}</td>
            <td className="py-1.5 text-right tabular-nums">{row.contacted}</td>
            <td className="py-1.5 text-right tabular-nums">{row.replied} <span className="text-faint">· {pct(row.contacted ? row.replied / row.contacted : null)}</span></td>
            <td className="py-1.5 text-right tabular-nums">{row.demoPlus} <span className="text-faint">· {pct(row.contacted ? row.demoPlus / row.contacted : null)}</span></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function PipelineAnalyticsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const weeks = Number.parseInt(params.weeks ?? "", 10);
  const [data, accounts, markets, settings] = await Promise.all([
    getPipelineAnalytics({ weeks: Number.isFinite(weeks) ? weeks : 8, sender: params.sender, agent: params.agent, market: params.market }),
    listEmailAccounts(),
    listMarkets(),
    getWorkspaceSettings(),
  ]);
  const labels = senderLabels(accounts);
  const accountName = (id: string) => labels.get(id) ?? accounts.find((a) => a.id === id)?.emailAddress ?? "Removed mailbox";
  const maxWeek = Math.max(1, ...data.weeks.map((w) => w.firstEmails + w.followUps + w.replies));
  const funnelTop = Math.max(1, data.funnel[0]?.count ?? 1);
  const day = (value: string) => formatDate(value, { day: "numeric", month: "short" }, data.scope.weekly.timezone);

  return (
    <div className="animate-fade-up" data-pipeline-analytics>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-12 font-bold uppercase tracking-[0.15em] text-faint">Pipeline · analytics</div>
          <h1 className="mt-1 text-28 font-bold leading-tight tracking-[-0.02em] text-ink">How outreach is converting</h1>
          <p className="mt-0.5 text-12 text-muted">Counted from what was recorded — sends, replies, bounces and your stage moves. Weeks start Monday.</p>
        </div>
        <Link href="/pipeline" className="btn-ghost btn-sm"><ArrowLeft size={12} /> Board</Link>
      </div>

      <div className="mb-4">
        <AutoFilters
          path="/pipeline/analytics"
          base={{ weeks: params.weeks, market: params.market, sender: params.sender, agent: params.agent }}
          selects={[
            { name: "weeks", label: "Weeks", options: [{ value: "", label: "Last 8 weeks" }, { value: "4", label: "Last 4 weeks" }, { value: "12", label: "Last 12 weeks" }, { value: "26", label: "Last 26 weeks" }] },
            { name: "tier", label: "Tier", disabled: true, note: "Reserved for the lead model", options: [{ value: "", label: "Tier: not recorded yet" }] },
            { name: "productFit", label: "Product fit", disabled: true, note: "Reserved for the lead model", options: [{ value: "", label: "Product fit: not recorded yet" }] },
            { name: "market", label: "Market", options: [{ value: "", label: "All markets" }, ...markets.map((m) => ({ value: m, label: m === "crypto" ? "Crypto" : CATEGORIES.find(c => c.value === m)?.label ?? m }))] },
            { name: "sender", label: "Sender", options: [{ value: "", label: "All senders" }, ...accounts.map((a) => ({ value: a.id, label: labels.get(a.id) ?? a.emailAddress })), { value: "none", label: "No sender yet" }] },
            { name: "agent", label: "Agent", options: [{ value: "", label: "All agents" }, ...Object.entries(AGENT_LABELS).map(([k, l]) => ({ value: k, label: l }))] },
          ]}
        />
      </div>

      <details className="mb-4 rounded-lg border border-line px-3 py-2 text-12 text-muted" data-metric-scope>
        <summary className="cursor-pointer font-semibold">What these numbers cover</summary>
        <ul className="mt-2 space-y-1">
          <li>{data.scope.population}</li>
          <li>{data.scope.weekly.label} Weeks use UTC.</li>
          <li>{data.scope.history.label}</li>
          <li>{data.scope.snapshot.label}</li>
        </ul>
      </details>
      <div className="grid gap-3 lg:grid-cols-2">
        <Section title="Funnel and current stages" note="Contact coverage and reply rate use recorded events. Later-stage counts are current snapshots, not inferred historical conversions.">
          <div className="space-y-2" data-funnel>
            {data.funnel.map((step) => (
              <div key={step.key}>
                <div className="flex items-baseline justify-between text-12">
                  <span className="font-semibold text-ink">{step.label}</span>
                  <span className="tabular-nums text-muted">
                    <strong className="text-ink">{step.count}</strong>
                    {step.conversion !== null && <span className="text-faint"> · {pct(step.conversion)} of previous</span>}
                  </span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-ink/[0.05]">
                  <div className="h-2 rounded-full bg-forest" style={{ width: `${Math.max(step.count ? 2 : 0, (step.count / funnelTop) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-12 text-faint">Demo and later steps use each lead’s current stage. Historical sales-stage conversions are unavailable for the imported leads; stage duration starts from audited moves, never estimates.</p>
        </Section>

        <Section title="Per week" note="Selected weeks (Monday UTC). Other = imported outbound with no recorded kind; no guess that it was a follow-up.">
          <div className="overflow-x-auto"><table className="w-full min-w-[430px] text-12" data-weeks>
            <thead>
              <tr className="text-left text-faint">
                <th className="pb-1.5 font-semibold">Week of</th>
                <th className="pb-1.5 font-semibold">Activity</th>
                <th className="pb-1.5 text-right font-semibold">1st</th>
                <th className="pb-1.5 text-right font-semibold">F-up</th>
                <th className="pb-1.5 text-right font-semibold">Replies</th>
                <th className="pb-1.5 text-right font-semibold">Yours</th>
                <th className="pb-1.5 text-right font-semibold" title="Unclassified imported outbound">Other</th>
                <th className="pb-1.5 text-right font-semibold">Reply time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.weeks.map((week) => (
                <tr key={week.start}>
                  <td className="py-1.5 font-semibold text-ink">{day(week.start)}</td>
                  <td className="w-[28%] py-1.5 pr-2">
                    <div className="flex h-2 overflow-hidden rounded-full bg-ink/[0.05]">
                      <div className="bg-forest" style={{ width: `${(week.firstEmails / maxWeek) * 100}%` }} />
                      <div className="bg-forest/50" style={{ width: `${(week.followUps / maxWeek) * 100}%` }} />
                      <div className="bg-lime" style={{ width: `${(week.replies / maxWeek) * 100}%` }} />
                    </div>
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{week.firstEmails}</td>
                  <td className="py-1.5 text-right tabular-nums">{week.followUps}</td>
                  <td className="py-1.5 text-right tabular-nums">{week.replies}</td>
                  <td className="py-1.5 text-right tabular-nums">{week.yourReplies}</td>
                  <td className="py-1.5 text-right tabular-nums">{week.unknownOutbound}</td>
                  <td className="py-1.5 text-right tabular-nums">{hours(week.medianReplyHours)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Section>

        <Section title="Replies after the first email vs each follow-up" note="All recorded history: which email a lead’s first reply came after, with a distinct lead denominator.">
          {data.bySequence.length === 0 ? (
            <p className="text-12 text-faint">Nothing sent in this view yet.</p>
          ) : (
            <table className="w-full text-12" data-by-sequence>
              <thead>
                <tr className="text-left text-faint">
                  <th className="pb-1.5 font-semibold">Email</th>
                  <th className="pb-1.5 text-right font-semibold">Sent</th>
                  <th className="pb-1.5 text-right font-semibold">First reply after it</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.bySequence.map((row) => (
                  <tr key={row.label}>
                    <td className="py-1.5 font-semibold text-ink">{row.label}</td>
                    <td className="py-1.5 text-right tabular-nums">{row.sent}</td>
                    <td className="py-1.5 text-right tabular-nums">{row.repliedAfter} <span className="text-faint">· {pct(row.rate)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title="Your reply speed and time in each stage" note="Answered speed and completed stage durations: all recorded history. Waiting replies: current snapshot.">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-reply-speed>
            {[
              ["Median reply", hours(data.replySpeed.medianHours)],
              ["Slowest 10%", hours(data.replySpeed.p90Hours)],
              ["Waiting now", String(data.replySpeed.waitingNow)],
              ["Over 24 h", String(data.replySpeed.waitingOver24h)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-line bg-white/60 px-2.5 py-2">
                <div className="whitespace-nowrap text-12 text-faint">{label}</div>
                <div className={`text-16 font-bold tabular-nums ${label === "Over 24 h" && data.replySpeed.waitingOver24h ? "text-rust" : "text-ink"}`}>{value}</div>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-12 text-faint">From {data.replySpeed.answered} answered messages.</p>
          <div className="mt-3 border-t border-line pt-3" data-stage-time>
            {data.stageTime.recordedSince ? (
              <ul className="space-y-1 text-12">
                {data.stageTime.rows.map((row) => (
                  <li key={row.stage} className="flex justify-between">
                    <span className="font-semibold capitalize text-ink">{row.stage === "proposal" ? "Commercial" : row.stage}</span>
                    <span className="tabular-nums text-muted">{row.medianDays === null ? "not enough moves yet" : `${row.medianDays.toFixed(1)} days median · ${row.samples} ${row.samples === 1 ? "move" : "moves"}`}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-12 text-muted">Time in each stage starts counting from your first stage move — none recorded yet.</p>
            )}
          </div>
        </Section>

        <Section title="Reply and demo rates" note="Tier and product fit await the lead model. Market means Forex, Metals, Crypto, Indices or Commodities — not country.">
          <div className="space-y-4" data-rates>
            <RateTable label="Signal market" rows={data.rates.market.map((row) => ({ name: row.key === "crypto" ? "Crypto" : CATEGORIES.find(c => c.value === row.key)?.label ?? row.key, row }))} />
            <p className="text-12 text-faint">A lead trading several markets appears in each relevant market row.</p>
            <details>
              <summary className="cursor-pointer text-12 font-semibold text-muted">Countries (optional)</summary>
              <div className="mt-2"><RateTable label="Country" rows={(data.rates.country ?? []).map((row) => ({ name: row.key, row }))} /></div>
            </details>
            <RateTable label="Sender" rows={data.rates.sender.map((row) => ({ name: row.key === "none" ? "No sender yet (default)" : accountName(row.key), row }))} />
            <RateTable label="Agent" rows={data.rates.agent.map((row) => ({ name: AGENT_LABELS[row.key as keyof typeof AGENT_LABELS] ?? "Unknown", row }))} />
          </div>
        </Section>

        <div className="space-y-3">
          <Section title="Bounce rate per mailbox" note="All recorded real accepted sends in this filtered population; sandbox excluded. The separate mailbox safety rule uses its last 50 sends.">
            {data.bounces.length === 0 ? (
              <p className="text-12 text-faint">No real accepted sends recorded in this view. Imported messages and sandbox sends are excluded.</p>
            ) : (
              <ul className="space-y-1 text-12" data-bounces>
                {data.bounces.map((row) => (
                  <li key={row.accountId} className="flex justify-between gap-2">
                    <span className="truncate font-semibold text-ink">{accountName(row.accountId)}</span>
                    <span className={`tabular-nums ${row.rate !== null && row.rate > 0.03 ? "text-rust" : "text-muted"}`}>
                      {row.permanentBounces} of {row.sends} · {pct(row.rate)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-12 text-faint">{data.scope.bounceAttribution}</p>
          </Section>

          <Section title={`Stale leads with no next step (${data.stale.count})`} note="In play, nothing for 14 days, and no next action, draft, due follow-up or waiting reply.">
            {data.stale.rows.length === 0 ? (
              <p className="text-12 text-faint">None — every lead in play has a next step.</p>
            ) : (
              <ul className="divide-y divide-line text-12" data-stale>
                {data.stale.rows.map((card) => (
                  <li key={card.prospectId} className="flex items-center justify-between gap-2 py-1.5">
                    <Link href={`/leads/${card.prospectId}`} className="min-w-0 truncate font-semibold text-ink hover:underline">{card.businessName}</Link>
                    <span className="shrink-0 text-faint">{card.statusLine.split(" — ")[0]} · {card.lastActivityAt ? relativeTime(card.lastActivityAt) : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </div>
  );
}
