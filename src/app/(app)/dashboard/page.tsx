import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  MailOpen,
  Radar,
  Reply,
  Send,
  Sparkles,
  Target,
  UsersRound,
  WandSparkles,
} from "lucide-react";
import { getDashboardData } from "@/lib/services/dashboard";
import { getWorkspaceSettings } from "@/lib/services/settings";
import {
  Card,
  CategoryList,
  EmptyState,
  Metric,
  Notice,
  PageHeader,
  ProgressBar,
  SectionHeading,
  StatusBadge,
  Avatar,
} from "@/components/ui";
import { SyncMailboxButton } from "@/components/sync-mailbox-button";
import { formatDate, relativeTime } from "@/lib/utils";
import { CLASSIFICATION_LABELS } from "@/lib/types";

export const dynamic = "force-dynamic";

function greeting(timezone: string): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hour12: false,
      timeZone: timezone,
    }).format(new Date()),
  );
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

export default async function DashboardPage() {
  const data = await getDashboardData();
  const { timezone } = await getWorkspaceSettings();
  const { metrics, activeJob, truth, account } = data;
  const sendMode = (process.env.EMAIL_DELIVERY_MODE || "sandbox").toLowerCase();

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow={formatDate(
          new Date(),
          {
            weekday: "long",
            day: "numeric",
            month: "long",
            year: "numeric",
          },
          timezone,
        )}
        title={
          <span>
            {greeting(timezone)}, founder.
            <span className="ml-3 inline-block align-middle font-sans text-12 font-semibold uppercase tracking-[0.14em] text-muted">
              {metrics.newWeek} new this week
            </span>
          </span>
        }
        description="A live read of the only loop that matters: find the right signal businesses, reach them properly, and keep the conversation moving."
        actions={
          <>
            <Link href="/email?tab=drafts" className="btn-secondary">
              Review drafts
              <span className="rounded-full bg-forest px-1.5 py-0.5 text-12 font-bold text-lime">
                {metrics.draftsOpen}
              </span>
            </Link>
            <Link href="/research" className="btn-primary">
              <Radar size={14} />
              New research
            </Link>
          </>
        }
      />

      {sendMode !== "live" && (
        <Notice
          tone="sandbox"
          title="Sandbox mode."
          action={
            <Link href="/settings#email" className="btn-secondary btn-sm shrink-0">
              Email settings
            </Link>
          }
        >
          Sends are composed and recorded, but no message leaves Growth. Switch{" "}
          <code className="rounded bg-forest/10 px-1 py-0.5 text-12">
            EMAIL_DELIVERY_MODE=live
          </code>{" "}
          only when the founder is ready to contact real prospects.
        </Notice>
      )}

      {!truth.approvedAt && (
        <div className="mt-3">
          <Notice
            tone="warning"
            title="Product Truth has not been approved."
            action={
              <Link href="/product-truth" className="btn-secondary btn-sm shrink-0">
                Review facts
              </Link>
            }
          >
            AI drafts are restricted to the one approved platform claim. Approve
            the real offer, pricing and limitations before scaling outreach.
          </Notice>
        </div>
      )}

      <section className="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Metric
          label="Verified leads"
          value={metrics.verified}
          hint={`${metrics.verifiedWithEmail} with a published email`}
          accent="lime"
          icon={<UsersRound size={12} />}
        />
        <Metric
          label="Drafts in review"
          value={metrics.draftsOpen}
          hint={`${metrics.draftsApproved} approved and ready`}
          accent="amber"
          icon={<WandSparkles size={12} />}
        />
        <Metric
          label="Replies waiting"
          value={metrics.unreadConversations}
          hint={`${metrics.repliesWeek} replies in the last 7 days`}
          accent={metrics.unreadConversations > 0 ? "rust" : "forest"}
          icon={<Reply size={12} />}
        />
        <Metric
          label="Live opportunities"
          value={metrics.opportunities}
          hint={`${metrics.won} won · ${metrics.sentWeek} emails sent this week`}
          accent="forest"
          icon={<Target size={12} />}
        />
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[1.45fr_1fr] [&>*]:min-w-0">
        <div className="card-dark relative overflow-hidden p-6">
          <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full border border-white/[0.06]" />
          <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full border border-white/[0.06]" />
          <div className="relative">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 text-12 font-bold uppercase tracking-[0.18em] text-lime">
                  <span className="h-1.5 w-1.5 rounded-full bg-lime" />
                  Live research target
                </div>
                <h2 className="display-title mt-3 text-display-sm leading-none text-white">
                  {activeJob ? activeJob.name : "No active research target"}
                </h2>
                <p className="mt-2 max-w-lg text-12 leading-5 text-white/45">
                  {activeJob
                    ? activeJob.requirements
                    : "Create a target, then let ChatGPT or Claude research through the shared Growth database."}
                </p>
              </div>
              <Link
                href="/research"
                className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/15 text-white/70 transition hover:border-lime hover:text-lime sm:flex"
                aria-label="Open research"
              >
                <ArrowRight size={15} />
              </Link>
            </div>

            {activeJob ? (
              <>
                <div className="mt-6 grid grid-cols-2 gap-3 border-t border-white/10 pt-5 sm:grid-cols-4">
                  {[
                    ["Target", activeJob.targetCount],
                    ["Verified", activeJob.verifiedCount],
                    ["Drafts", activeJob.draftCount],
                    ["Remaining", activeJob.remaining],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <div className="text-28 leading-none text-white">
                        {value}
                      </div>
                      <div className="mt-1 text-12 font-semibold uppercase tracking-[0.14em] text-white/35">
                        {label}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-5">
                  <div className="mb-2 flex items-center justify-between text-12 text-white/38">
                    <span>{activeJob.regions}</span>
                    <span>
                      {activeJob.verifiedCount}/{activeJob.targetCount} verified
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full rounded-full bg-lime transition-all"
                      style={{
                        width: `${Math.min(
                          100,
                          (activeJob.verifiedCount / activeJob.targetCount) * 100,
                        )}%`,
                      }}
                    />
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-4 text-12 text-white/35">
                  <span className="inline-flex items-center gap-1.5">
                    <Send size={11} /> {data.followUps.sent} follow-ups sent
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <CheckCircle2 size={11} /> {activeJob.duplicatesRejected} duplicates
                    rejected
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Clock3 size={11} /> Progress stored in the database
                  </span>
                </div>
              </>
            ) : (
              <Link href="/research" className="btn-lime mt-6">
                Create the first research target
                <ArrowRight size={14} />
              </Link>
            )}
          </div>
        </div>

        <Card className="p-5">
          <SectionHeading
            title="Pipeline"
            description="One live stage per prospect. No enterprise CRM maze."
            action={
              <Link href="/leads" className="btn-ghost btn-sm">
                All leads <ArrowRight size={12} />
              </Link>
            }
          />
          <div className="mt-5 space-y-3">
            {[
              {
                label: "Verified",
                value:
                  (data.pipelineCounts.verified ?? 0) +
                  (data.pipelineCounts.new ?? 0),
                color: "bg-[#7898b9]",
              },
              {
                label: "Drafted",
                value: data.pipelineCounts.draft_prepared ?? 0,
                color: "bg-[#d2a24c]",
              },
              {
                label: "Contacted",
                value: data.pipelineCounts.contacted ?? 0,
                color: "bg-[#547d68]",
              },
              {
                label: "Replied",
                value: data.pipelineCounts.replied ?? 0,
                color: "bg-[#b77418]",
              },
              {
                label: "Interested + demo",
                value:
                  (data.pipelineCounts.interested ?? 0) +
                  (data.pipelineCounts.demo ?? 0) +
                  (data.pipelineCounts.proposal ?? 0),
                color: "bg-forest",
              },
              {
                label: "Won",
                value: data.pipelineCounts.won ?? 0,
                color: "bg-lime",
              },
            ].map((stage) => {
              const total = Math.max(
                1,
                metrics.verified,
                Object.values(data.pipelineCounts).reduce(
                  (sum, value) => sum + value,
                  0,
                ),
              );
              return (
                <div key={stage.label}>
                  <div className="flex items-center justify-between text-12">
                    <span className="font-medium text-muted">{stage.label}</span>
                    <span className="font-bold text-ink">{stage.value}</span>
                  </div>
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink/[0.06]">
                    <div
                      className={`h-full rounded-full ${stage.color}`}
                      style={{
                        width: `${Math.max(
                          stage.value > 0 ? 3 : 0,
                          (stage.value / total) * 100,
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[1.1fr_1.45fr] [&>*]:min-w-0">
        <Card className="p-0">
          <div className="flex items-center justify-between px-5 pt-5">
            <SectionHeading
              title="Replies in the room"
              description="Real conversations, newest first."
            />
            <Link href="/email" className="btn-ghost btn-sm">
              Inbox <ArrowRight size={12} />
            </Link>
          </div>
          <div className="mt-2 px-2 pb-2">
            {data.recentConversations.length === 0 ? (
              <EmptyState
                icon="inbox"
                title="No replies yet"
                description="Once a prospect replies, the thread lands here and follow-ups for that prospect stop automatically."
              />
            ) : (
              data.recentConversations.map((conversation) => (
                <Link
                  key={conversation.id}
                  href={`/email/${conversation.id}`}
                  className="flex items-start gap-3 rounded-xl px-3 py-3 transition hover:bg-ink/[0.03]"
                >
                  <Avatar name={conversation.prospectName} size="sm" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-12 font-semibold text-ink">
                        {conversation.prospectName}
                      </span>
                      <span className="shrink-0 text-12 text-faint">
                        {relativeTime(conversation.lastInboundAt)}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-12 text-muted">
                      {conversation.snippet || conversation.subject}
                    </div>
                    <span className="mt-1.5 inline-flex rounded-full border border-line bg-white px-2 py-0.5 text-12 font-semibold text-muted">
                      {CLASSIFICATION_LABELS[conversation.classification]}
                    </span>
                  </div>
                  {conversation.unreadCount > 0 && (
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />
                  )}
                </Link>
              ))
            )}
          </div>
        </Card>

        <Card className="p-0">
          <div className="flex items-center justify-between px-5 pt-5">
            <SectionHeading
              title="Recently discovered"
              description="Evidence and contact details live on each lead page."
            />
            <Link href="/leads" className="btn-ghost btn-sm">
              All <ArrowRight size={12} />
            </Link>
          </div>
          {data.recentProspects.length === 0 ? (
            <EmptyState
              icon="sparkles"
              title="The database is ready for its first lead"
              description="Create a research target and let an assistant save verified providers."
              action={
                <Link href="/research" className="btn-primary btn-sm">
                  Open research
                </Link>
              }
            />
          ) : (
            <div className="table-wrap mt-2">
              <table className="table">
                <thead>
                  <tr>
                    <th>Business</th>
                    <th>Markets</th>
                    <th>Stage</th>
                    <th className="text-right">Added</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentProspects.map((prospect) => (
                    <tr key={prospect.id} className="cursor-pointer">
                      <td>
                        <Link href={`/leads/${prospect.id}`} className="block">
                          <div className="font-semibold text-ink">
                            {prospect.businessName}
                          </div>
                          <div className="mt-0.5 text-12 text-faint">
                            {prospect.country || "Country unknown"} ·{" "}
                            {prospect.contactEmail || "No email"}
                          </div>
                        </Link>
                      </td>
                      <td>
                        <CategoryList categories={prospect.categories} limit={2} />
                      </td>
                      <td>
                        <StatusBadge status={prospect.status} />
                      </td>
                      <td className="text-right text-12 text-faint">
                        {relativeTime(prospect.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </section>

      <section className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Card className="p-5">
          <div className="flex items-start justify-between">
            <div className="grid h-8 w-8 place-items-center rounded-full bg-forest/[0.06] text-forest">
              <MailOpen size={15} />
            </div>
            {account && (
              <span
                className={`badge ${
                  account.status === "connected"
                    ? "border-forest/20 bg-lime/25 text-forest"
                    : "border-rust/20 bg-rust/[0.05] text-rust"
                }`}
              >
                <span className="badge-dot" />
                {account.status === "connected" ? "Connected" : account.status}
              </span>
            )}
          </div>
          <div className="mt-4 text-12 font-semibold text-ink">Mailbox</div>
          <div className="mt-0.5 truncate text-12 text-muted">
            {account?.emailAddress || "No account connected"}
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="text-12 text-faint">
              {account?.provider === "sandbox"
                ? "Sandbox — no IMAP/SMTP"
                : data.lastSync
                  ? `Synced ${relativeTime(data.lastSync)}`
                  : "Never synced"}
            </div>
            {account && account.provider !== "sandbox" && (
              <SyncMailboxButton
                accountId={account.id}
                className="btn-secondary btn-xs"
                label="Sync"
              />
            )}
          </div>
          {data.hasIncompleteHistory && (
            <div className="mt-3 rounded-lg bg-amber/[0.07] px-2.5 py-2 text-12 leading-4 text-[#76501a]">
              Mailbox history is incomplete. Some older email may not be threaded.
            </div>
          )}
        </Card>

        <Card className="p-5">
          <div className="flex items-start justify-between">
            <div className="grid h-8 w-8 place-items-center rounded-full bg-forest/[0.06] text-forest">
              <Clock3 size={15} />
            </div>
            <span className="badge">
              {data.followUps.dueCandidates} due
            </span>
          </div>
          <div className="mt-4 text-12 font-semibold text-ink">Follow-ups</div>
          <div className="mt-0.5 text-12 text-muted">
            {data.followUps.waiting} conversations waiting ·{" "}
            {data.followUps.readyDrafts} drafts ready
          </div>
          <div className="mt-3 flex items-center justify-between">
            <div className="text-12 text-faint">
              Replies and opt-outs stop this automatically.
            </div>
            <Link href="/email?tab=followups" className="btn-ghost btn-xs">
              Review <ArrowRight size={11} />
            </Link>
          </div>
        </Card>

        <Card className="p-5 sm:col-span-2 xl:col-span-1">
          <div className="flex items-start justify-between">
            <div className="grid h-8 w-8 place-items-center rounded-full bg-lime/40 text-forest">
              <Sparkles size={15} />
            </div>
            <span
              className={`badge ${
                truth.status === "approved"
                  ? "border-forest/20 bg-lime/25 text-forest"
                  : "border-amber/20 bg-amber/[0.06] text-amber"
              }`}
            >
              {truth.status === "approved" ? "Approved" : "Needs review"}
            </span>
          </div>
          <div className="mt-4 text-12 font-semibold text-ink">
            Product Truth v{truth.version}
          </div>
          <div className="mt-0.5 line-clamp-2 text-12 leading-5 text-muted">
            {truth.oneLiner}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <div className="text-12 text-faint">
              {truth.approvedClaims.length} approved claims
            </div>
            <Link href="/product-truth" className="btn-ghost btn-xs">
              Edit <ArrowRight size={11} />
            </Link>
          </div>
        </Card>
      </section>
    </div>
  );
}
