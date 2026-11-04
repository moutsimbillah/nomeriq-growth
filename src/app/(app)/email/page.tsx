import Link from "next/link";
import {
  ArrowRight,
  CircleAlert,
  FileText,
  Inbox,
  Mail,
  MailCheck,
  MessageSquare,
  Plus,
  Reply,
  Send,
  Sparkles,
} from "lucide-react";
import {
  getConversation,
  listConversations,
  listSentMessages,
  listUnknownInbound,
} from "@/lib/services/conversations";
import { listDrafts } from "@/lib/services/drafts";
import { AGENT_LABELS, AGENT_TAGS } from "@/lib/agent/agentTag";
import {
  getFollowUpOverview,
  listFollowUpCandidates,
  listFollowUpDrafts,
} from "@/lib/services/followups";
import { listCampaigns } from "@/lib/services/campaigns";
import { listEmailAccounts } from "@/lib/email/accounts";
import { getSyncHealth } from "@/lib/email/sync";
import {
  AgentPill,
  Card,
  EmptyState,
  Notice,
  PageHeader,
  SectionHeading,
  Tabs,
} from "@/components/ui";
import { SyncMailboxButton } from "@/components/sync-mailbox-button";
import {
  CampaignActions,
  FollowUpReview,
  NewCampaignButton,
  PrepareFollowUpsButton,
} from "@/components/email-actions";
import { formatDateTime, relativeTime, truncate } from "@/lib/utils";
import { CLASSIFICATION_LABELS } from "@/lib/types";

export const dynamic = "force-dynamic";

const TAB_LABELS = ["Inbox", "Sent", "Drafts", "Campaigns", "Follow-ups"];

function classificationClass(classification: string) {
  if (["interested", "demo"].includes(classification))
    return "border-forest/20 bg-lime/25 text-forest";
  if (["pricing", "features", "technical"].includes(classification))
    return "border-amber/20 bg-amber/[0.07] text-amber";
  if (["unsubscribe", "not_interested"].includes(classification))
    return "border-rust/20 bg-rust/[0.05] text-rust";
  return "border-line bg-white text-muted";
}

export default async function EmailPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; agent?: string }>;
}) {
  const params = await searchParams;
  const tabMap: Record<string, string> = {
    inbox: "Inbox",
    sent: "Sent",
    drafts: "Drafts",
    campaigns: "Campaigns",
    followups: "Follow-ups",
    "follow-ups": "Follow-ups",
  };
  const active = tabMap[(params.tab || "inbox").toLowerCase()] || "Inbox";

  const [
    conversations,
    sent,
    drafts,
    campaigns,
    followOverview,
    followCandidates,
    followDrafts,
    accounts,
    unknown,
  ] = await Promise.all([
    listConversations({ onlyReplied: true, limit: 100 }),
    listSentMessages(100),
    listDrafts(undefined, 120, params.agent),
    listCampaigns(),
    getFollowUpOverview(),
    listFollowUpCandidates(),
    listFollowUpDrafts(),
    listEmailAccounts(),
    listUnknownInbound(20),
  ]);
  const account = accounts[0] ?? null;
  const syncHealth =
    account && account.provider !== "sandbox"
      ? await getSyncHealth(account.id).catch(() => [])
      : [];
  const openDrafts = drafts.filter((draft) => draft.status === "draft");
  const approvedFirstContact = drafts.filter(
    (draft) => draft.kind === "first_contact" && draft.status === "approved",
  );
  const dueFollowUps = followCandidates.filter((candidate) => candidate.due);
  const sandbox =
    (process.env.EMAIL_DELIVERY_MODE || "sandbox").toLowerCase() !== "live" ||
    account?.provider === "sandbox";
  const tabs = [
    {
      href: "/email?tab=inbox",
      label: "Inbox",
      count: conversations.reduce((sum, item) => sum + item.unreadCount, 0),
    },
    { href: "/email?tab=sent", label: "Sent", count: sent.length },
    { href: "/email?tab=drafts", label: "Drafts", count: openDrafts.length },
    {
      href: "/email?tab=campaigns",
      label: "Campaigns",
      count: campaigns.filter((campaign) => campaign.status === "active").length,
    },
    {
      href: "/email?tab=followups",
      label: "Follow-ups",
      count: dueFollowUps.length,
    },
  ];

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Mailbox and conversations"
        title="The mailbox, without the busywork."
        description="Approved outreach, real replies and the IONOS sent folder in one thread-aware queue. Replies stop follow-ups automatically; opt-outs suppress instantly."
        actions={
          <>
            {account && account.provider !== "sandbox" && (
              <SyncMailboxButton accountId={account.id} />
            )}
            <Link href="/email?tab=campaigns" className="btn-primary">
              <Send size={14} />
              Campaigns
            </Link>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-white/45 px-3.5 py-2.5">
        <div className="flex items-center gap-2 text-[10.5px] text-muted">
          <Mail size={13} className={account?.status === "connected" ? "text-forest" : "text-amber"} />
          <span className="font-semibold text-ink">{account?.emailAddress || "No mailbox"}</span>
          {account?.provider === "sandbox" ? (
            <span className="badge border-amber/20 bg-amber/[0.07] text-amber">sandbox</span>
          ) : (
            <span
              className={`badge ${
                account?.status === "connected"
                  ? "border-forest/20 bg-lime/25 text-forest"
                  : "border-rust/20 bg-rust/[0.05] text-rust"
              }`}
            >
              {account?.status || "not connected"}
            </span>
          )}
          {account?.lastSyncAt && (
            <span className="text-faint">· synced {relativeTime(account.lastSyncAt)}</span>
          )}
          {syncHealth.some((state) => !state.historyComplete || state.error) && (
            <span className="inline-flex items-center gap-1 text-[9.5px] text-amber">
              <CircleAlert size={9} /> History incomplete
            </span>
          )}
        </div>
        <Link href="/settings#email" className="text-[10px] font-semibold text-muted hover:text-ink">
          Manage mailbox →
        </Link>
      </div>

      <Tabs tabs={tabs} active={active} />

      {active === "Inbox" && (
        <div className="mt-4 space-y-4">
          <Card className="overflow-hidden">
            {conversations.length === 0 ? (
              <EmptyState
                icon="inbox"
                title="No prospect replies yet"
                description="When someone replies to an approved email, Growth associates the message by thread headers and exact email, then puts it here."
                action={
                  <Link href="/email?tab=drafts" className="btn-primary btn-sm">
                    Review drafts
                  </Link>
                }
              />
            ) : (
              <div className="divide-y divide-line">
                {conversations.map((conversation) => (
                  <Link
                    key={conversation.id}
                    href={`/email/${conversation.id}`}
                    className="flex items-start gap-4 px-5 py-4 transition hover:bg-ink/[0.025]"
                  >
                    <div
                      className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full ${
                        conversation.unreadCount > 0
                          ? "bg-forest text-lime"
                          : "bg-paper-deep text-muted"
                      }`}
                    >
                      <Reply size={14} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[12.5px] font-bold text-ink">
                          {conversation.prospectName}
                        </span>
                        <span
                          className={`pill ${classificationClass(conversation.classification)}`}
                        >
                          {CLASSIFICATION_LABELS[conversation.classification]}
                        </span>
                        {conversation.unreadCount > 0 && (
                          <span className="h-1.5 w-1.5 rounded-full bg-amber" />
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] font-medium text-ink/75">
                        {conversation.subject}
                      </div>
                      <div className="mt-1 line-clamp-1 text-[10.5px] text-muted">
                        {conversation.snippet || "Open the thread to read the reply."}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-[9.5px] text-faint">
                        {relativeTime(conversation.lastInboundAt)}
                      </div>
                      <span className="btn-ghost btn-xs mt-1">
                        Open <ArrowRight size={10} />
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </Card>

          {unknown.length > 0 && (
            <Card className="p-5">
              <SectionHeading
                title="Unmatched inbound"
                description="Messages from senders Growth could not associate to a prospect. They are never auto-promoted into leads."
              />
              <div className="mt-3 space-y-2">
                {unknown.map((message) => (
                  <div
                    key={message.id}
                    className="rounded-xl border border-line bg-paper/40 px-3 py-2.5"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[11px] font-semibold text-ink">
                        {message.fromEmail}
                      </span>
                      <span className="text-[9px] text-faint">
                        {relativeTime(message.receivedAt)}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[10.5px] text-muted">
                      {message.subject}
                    </div>
                    <div className="mt-1 line-clamp-2 text-[10px] leading-4 text-faint">
                      {truncate(message.bodyText, 200)}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {active === "Sent" && (
        <Card className="mt-4 overflow-hidden">
          {sent.length === 0 ? (
            <EmptyState
              icon="sparkles"
              title="Nothing sent yet"
              description="Approved drafts and replies sent through Growth, plus messages found in the IONOS Sent folder, appear here."
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Recipient</th>
                    <th>Subject</th>
                    <th>Transport</th>
                    <th>Status</th>
                    <th className="text-right">Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {sent.map((message) => (
                    <tr key={message.id}>
                      <td>
                        <div className="font-semibold text-ink">
                          {message.prospectName || message.to}
                        </div>
                        <div className="text-[9.5px] text-faint">{message.to}</div>
                      </td>
                      <td>
                        {message.conversationId ? (
                          <Link
                            href={`/email/${message.conversationId}`}
                            className="line-clamp-1 max-w-[320px] text-[11px] text-ink hover:underline"
                          >
                            {message.subject}
                          </Link>
                        ) : (
                          <span className="line-clamp-1 max-w-[320px] text-[11px] text-ink">
                            {message.subject}
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="badge">
                          {message.external ? "IONOS Sent folder" : message.isSandbox ? "Sandbox" : "Growth SMTP"}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`badge ${
                            message.isSandbox
                              ? "border-amber/20 bg-amber/[0.06] text-amber"
                              : message.deliveryStatus === "accepted"
                                ? "border-forest/20 bg-lime/20 text-forest"
                                : "border-rust/20 bg-rust/[0.05] text-rust"
                          }`}
                        >
                          {message.isSandbox ? "not delivered" : message.deliveryStatus}
                        </span>
                      </td>
                      <td className="text-right text-[9.5px] text-faint">
                        {formatDateTime(message.sentAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {active === "Drafts" && (
        <Card className="mt-4 overflow-hidden">
          <form className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3" method="GET">
            <input type="hidden" name="tab" value="drafts" />
            <select name="agent" defaultValue={params.agent || ""} className="select w-auto min-w-[170px]">
              <option value="">All agents</option>
              {AGENT_TAGS.map((tag) => (
                <option key={tag} value={tag}>
                  {AGENT_LABELS[tag]} ({drafts.filter((draft) => draft.sourceAgent === tag).length})
                </option>
              ))}
            </select>
            <button type="submit" className="btn-secondary btn-sm">
              Filter
            </button>
          </form>
          {drafts.length === 0 ? (
            <EmptyState
              icon="sparkles"
              title="No drafts yet"
              description="A saved personalized draft is created for every verified prospect. Open a lead to generate one."
              action={
                <Link href="/leads" className="btn-primary btn-sm">
                  Open leads
                </Link>
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Prospect</th>
                    <th>Type</th>
                    <th>Subject</th>
                    <th>Saved by</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th className="text-right">Review</th>
                  </tr>
                </thead>
                <tbody>
                  {drafts.map((draft) => (
                    <tr key={draft.id}>
                      <td className="font-semibold text-ink">{draft.prospectName}</td>
                      <td>
                        <span className="badge capitalize">
                          {draft.kind.replace("_", " ")}
                          {draft.kind === "follow_up" ? ` #${draft.sequence}` : ""}
                        </span>
                      </td>
                      <td className="max-w-[290px] truncate text-[11px]">{draft.subject}</td>
                      <td>
                        <AgentPill
                          agent={draft.sourceAgent ?? "unknown"}
                          channel={draft.sourceChannel}
                          note={draft.sourceAgent === "other" ? draft.sourceClient : undefined}
                        />
                      </td>
                      <td>
                        <span
                          className={`badge capitalize ${
                            draft.status === "approved"
                              ? "border-forest/20 bg-lime/25 text-forest"
                              : draft.status === "sent"
                                ? "border-forest bg-forest text-lime"
                                : ""
                          }`}
                        >
                          {draft.status}
                        </span>
                      </td>
                      <td className="text-[9.5px] text-faint">{relativeTime(draft.updatedAt)}</td>
                      <td className="text-right">
                        <Link href={`/leads/${draft.prospectId}`} className="btn-ghost btn-xs">
                          Open lead <ArrowRight size={10} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {active === "Campaigns" && (
        <div className="mt-4 space-y-4">
          <Notice tone="info" title="Batch sending is founder-authorized.">
            Create a campaign from approved first-contact drafts. Nothing sends
            automatically. The runner lives in this tab and respects the
            configured interval and 24-hour safety cap.
          </Notice>
          <Card className="p-0">
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
              <SectionHeading
                title="Campaigns"
                description="A small, explicit batch queue — not an email blaster."
              />
              <NewCampaignButton
                drafts={approvedFirstContact.map((draft) => ({
                  id: draft.id,
                  prospectName: draft.prospectName || "Prospect",
                  subject: draft.subject,
                }))}
                accounts={accounts.map((account) => ({
                  id: account.id,
                  emailAddress: account.emailAddress,
                  provider: account.provider,
                  status: account.status,
                }))}
              />
            </div>
            {campaigns.length === 0 ? (
              <EmptyState
                icon="sparkles"
                title="No campaigns yet"
                description={
                  approvedFirstContact.length
                    ? `${approvedFirstContact.length} approved first-contact draft${approvedFirstContact.length === 1 ? " is" : "s are"} ready to queue.`
                    : "Approve at least one first-contact draft on its lead page first."
                }
              />
            ) : (
              <div className="table-wrap mt-3">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Campaign</th>
                      <th>Progress</th>
                      <th>Status</th>
                      <th>Account</th>
                      <th className="text-right">Control</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map((campaign) => (
                      <tr key={campaign.id}>
                        <td>
                          <div className="font-semibold text-ink">{campaign.name}</div>
                          <div className="text-[9.5px] text-faint">
                            Created {relativeTime(campaign.createdAt)}
                          </div>
                        </td>
                        <td>
                          <div className="text-[11px] text-ink">
                            {campaign.sent} of {campaign.total} sent
                          </div>
                          <div className="text-[9.5px] text-faint">
                            {campaign.failed} failed · {campaign.queued} queued
                          </div>
                        </td>
                        <td>
                          <span className="badge capitalize">{campaign.status}</span>
                        </td>
                        <td className="text-[10px] text-muted">{campaign.accountEmail}</td>
                        <td>
                          <CampaignActions campaign={campaign} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {active === "Follow-ups" && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-4 [&>*]:min-w-0">
            {[
              ["Waiting", followOverview.waiting],
              ["Due now", followOverview.due],
              ["Drafts ready", followOverview.readyDrafts],
              ["Cancelled by reply", followOverview.cancelled],
            ].map(([label, value]) => (
              <Card key={label} className="p-4">
                <div className="font-display text-[28px] leading-none">{value}</div>
                <div className="mt-1 text-[9px] font-bold uppercase tracking-[0.12em] text-faint">
                  {label}
                </div>
              </Card>
            ))}
          </div>
          <Card className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <SectionHeading
                title="Unanswered conversations"
                description="A reply, opt-out, suppression or disqualifying stage stops the sequence. No message is ever sent automatically."
              />
              <PrepareFollowUpsButton />
            </div>
            {followDrafts.length === 0 ? (
              <EmptyState
                icon="inbox"
                title="No follow-ups prepared"
                description="Once a contacted thread passes the configured waiting period without a reply, its personalized follow-up can be prepared here."
              />
            ) : (
              <div className="mt-4 space-y-2">
                {followDrafts.map((draft) => (
                  <div
                    key={draft.id}
                    className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-white/50 px-3.5 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[11.5px] font-semibold text-ink">
                          {draft.prospectName}
                        </span>
                        <span className="badge">#{draft.sequence}</span>
                        <span className="badge capitalize">{draft.status}</span>
                      </div>
                      <div className="mt-0.5 truncate text-[10px] text-muted">
                        {draft.subject} · {truncate(draft.body.replace(/\n+/g, " "), 130)}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <FollowUpReview draft={draft} sandbox={sandbox} />
                      <Link href={`/leads/${draft.prospectId}`} className="btn-ghost btn-xs">
                        Lead <ArrowRight size={10} />
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card className="p-5">
            <SectionHeading
              title="Eligible but not yet prepared"
              description={`${followOverview.due} due now. Preparing creates drafts only; sending still needs founder review.`}
            />
            {dueFollowUps.length === 0 ? (
              <p className="mt-3 text-[11px] text-faint">Nothing is due.</p>
            ) : (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {dueFollowUps.map((candidate) => (
                  <div
                    key={candidate.conversationId}
                    className="flex items-center justify-between rounded-lg border border-line bg-paper/40 px-3 py-2.5"
                  >
                    <div>
                      <div className="text-[11px] font-semibold text-ink">
                        {candidate.businessName}
                      </div>
                      <div className="text-[9.5px] text-faint">
                        {candidate.daysSinceLastOutbound} days since contact · next #
                        {candidate.nextSequence}
                      </div>
                    </div>
                    <Link href={`/email/${candidate.conversationId}`} className="btn-ghost btn-xs">
                      Thread <ArrowRight size={10} />
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
