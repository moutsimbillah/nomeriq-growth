import Link from "next/link";
import { MessageLinkActions } from "@/components/message-link-actions";
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
  getConversationCounts,
  listConversations,
  listSentMessagesPage,
  listUnknownInbound,
  SENT_PAGE_SIZE,
} from "@/lib/services/conversations";
import { defaultSenderLabel, NO_SENDER_LABEL, senderLabels, senderShortName } from "@/lib/email/senderPill";
import {
  countDrafts,
  DRAFT_PAGE_SIZE,
  getDraftOriginFacets,
  listDraftsPage,
} from "@/lib/services/drafts";
import { ADDED_LABELS, COUNTED_ADDED_RANGES } from "@/lib/dates/pakistan";
import { readLeadFilters } from "@/lib/leads/leadFilters";
import { AGENT_LABELS, AGENT_TAGS } from "@/lib/agent/agentTag";
import {
  FOLLOW_UP_DRAFT_PAGE_SIZE,
  getFollowUpOverview,
  listFollowUpCandidates,
  listFollowUpDraftsPage,
} from "@/lib/services/followups";
import { FollowUpDraftList, FollowUpEligibleList } from "@/components/follow-up-bulk";
import { listCampaigns } from "@/lib/services/campaigns";
import { listEmailAccounts } from "@/lib/email/accounts";
import { getSyncHealth } from "@/lib/email/sync";
import { getWorkspaceSettings } from "@/lib/services/settings";
import {
  AgentPill,
  SenderPill,
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
  NewCampaignButton,
} from "@/components/email-actions";
import { formatDateTime, relativeTime, truncate } from "@/lib/utils";
import { CLASSIFICATION_LABELS } from "@/lib/types";

/** The Email tools behind `/email?tab=…`: the mailbox list (with unmatched inbound), Sent, Drafts,
 * Campaigns and Follow-ups. `/email` itself is the folder inbox. */
const TAB_LABELS = ["Mailbox list", "Sent", "Drafts", "Campaigns", "Follow-ups"];

function classificationClass(classification: string) {
  if (["interested", "demo"].includes(classification))
    return "border-forest/20 bg-lime/25 text-forest";
  if (["pricing", "features", "technical"].includes(classification))
    return "border-amber/20 bg-amber/[0.07] text-amber";
  if (["unsubscribe", "not_interested"].includes(classification))
    return "border-rust/20 bg-rust/[0.05] text-rust";
  return "border-line bg-white text-muted";
}

export async function EmailToolsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const settings = await getWorkspaceSettings();
  // the same reader the leads page uses, so ?added= and the date inputs mean the same thing here
  const filters = {
    ...readLeadFilters(params),
    timezone: settings.timezone,
    now: new Date(),
  };
  const tabMap: Record<string, string> = {
    inbox: "Mailbox list",
    sent: "Sent",
    drafts: "Drafts",
    campaigns: "Campaigns",
    followups: "Follow-ups",
    "follow-ups": "Follow-ups",
  };
  const active = tabMap[(params.tab || "inbox").toLowerCase()] || "Mailbox list";

  // Each tab's window is the query string's `limit`, so "Load more" only has to raise it. Every
  // service below clamps the window to the true counted total, and the page prints that total, so a
  // capped page is never presented as the count.
  const requestedLimit = Number.parseInt(params.limit ?? "", 10);
  const windowFromUrl = (fallback: number) =>
    Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : fallback;
  const draftWindow = windowFromUrl(DRAFT_PAGE_SIZE);
  const sentWindow = windowFromUrl(SENT_PAGE_SIZE);
  const followUpDraftWindow = windowFromUrl(FOLLOW_UP_DRAFT_PAGE_SIZE);

  const [
    conversations,
    sentPage,
    draftPage,
    campaigns,
    followOverview,
    followCandidates,
    followDraftPage,
    accounts,
    unknown,
    inboxCounts,
    openDraftTotal,
  ] = await Promise.all([
    listConversations({ onlyReplied: true, limit: 100 }),
    listSentMessagesPage(sentWindow),
    listDraftsPage(undefined, draftWindow, filters.agent, {
      agent: filters.agent,
      sender: filters.sender,
      added: filters.added,
      addedFrom: filters.addedFrom,
      addedTo: filters.addedTo,
      timezone: filters.timezone,
      now: filters.now,
    }),
    listCampaigns(),
    getFollowUpOverview(),
    listFollowUpCandidates(),
    listFollowUpDraftsPage(followUpDraftWindow),
    listEmailAccounts(),
    listUnknownInbound(20),
    getConversationCounts({ onlyReplied: true }),
    countDrafts("draft", filters.agent, {
      agent: filters.agent,
      sender: filters.sender,
      added: filters.added,
      addedFrom: filters.addedFrom,
      addedTo: filters.addedTo,
      timezone: filters.timezone,
      now: filters.now,
    }),
  ]);
  const sent = sentPage.rows;
  const followDrafts = followDraftPage.rows;
  const drafts = draftPage.rows;
  const draftsTotal = draftPage.total;
  /** A "Load more" href that keeps every active parameter and only raises the window. */
  const loadMoreHref = (tab: string, current: number, step: number, total: number) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value && key !== "limit") next.set(key, value);
    }
    next.set("tab", tab);
    next.set("limit", String(Math.min(current + step, total)));
    return `/email?${next.toString()}`;
  };
  const draftLoadMoreHref = loadMoreHref("drafts", draftPage.limit, DRAFT_PAGE_SIZE, draftsTotal);
  const sentLoadMoreHref = loadMoreHref("sent", sentPage.limit, SENT_PAGE_SIZE, sentPage.total);
  const followUpLoadMoreHref = loadMoreHref(
    "followups",
    followDraftPage.limit,
    FOLLOW_UP_DRAFT_PAGE_SIZE,
    followDraftPage.total,
  );
  const senderLabelById = senderLabels(accounts);
  const defaultProfile = accounts.find((account) => account.isDefault) ?? accounts[0] ?? null;
  const defaultLabel = defaultSenderLabel(defaultProfile);
  const draftSenderTitle = (profileId: string | null | undefined) => {
    if (!profileId) {
      // A never-default mailbox is not a default, so this sentence must not promise it will send.
      if (defaultProfile?.neverDefault) {
        return `${NO_SENDER_LABEL} — no mailbox is the default, so pin a sending profile on this lead before emailing it`;
      }
      return defaultProfile
        ? `No sending profile yet — ${defaultProfile.emailAddress} (${defaultProfile.name}) is the default and will send`
        : "No sending profile yet, and no default mailbox is connected";
    }
    const account = accounts.find((row) => row.id === profileId);
    return account ? `${account.emailAddress} — ${account.name}` : "Sending profile";
  };

  const draftFacets = await getDraftOriginFacets(undefined, {
    agent: filters.agent,
    sender: filters.sender,
    added: filters.added,
    addedFrom: filters.addedFrom,
    addedTo: filters.addedTo,
    timezone: filters.timezone,
    now: filters.now,
  });
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
  // "Eligible but not yet prepared": due, and no draft is already waiting for review.
  const unpreparedFollowUps = dueFollowUps.filter((candidate) => !candidate.activeDraftId);
  const sandbox =
    (process.env.EMAIL_DELIVERY_MODE || "sandbox").toLowerCase() !== "live" ||
    account?.provider === "sandbox";
  const tabs = [
    { href: "/email", label: "Folder inbox" },
    {
      href: "/email?tab=inbox",
      label: "Mailbox list",
      // The unread total for the whole filter, not the sum over the loaded window.
      count: inboxCounts.unread,
    },
    { href: "/email?tab=sent", label: "Sent", count: sentPage.total },
    {
      href: "/email?tab=drafts",
      label: "Drafts",
      // Every open draft the filter admits, not just the ones this page loaded.
      count: openDraftTotal,
    },
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
        <div className="flex items-center gap-2 text-12 text-muted">
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
            <span className="inline-flex items-center gap-1 text-12 text-amber">
              <CircleAlert size={9} /> History incomplete
            </span>
          )}
        </div>
        <Link href="/settings#email" className="text-12 font-semibold text-muted hover:text-ink">
          Manage mailbox →
        </Link>
      </div>

      <Tabs tabs={tabs} active={active} />

      {active === "Mailbox list" && (
        <div className="mt-4 space-y-4">
          {/* The loaded window is never presented as the total: the service counts the whole filtered set. */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-12 text-muted">
            <span>
              Showing <strong className="font-bold text-ink">{conversations.length}</strong> of{" "}
              <strong className="font-bold text-ink">{inboxCounts.total}</strong>{" "}
              {inboxCounts.total === 1 ? "conversation" : "conversations"}
            </span>
            <span className="text-faint">
              {inboxCounts.unread} unread {inboxCounts.unread === 1 ? "reply" : "replies"}
            </span>
          </div>
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
                        <span className="text-13 font-bold text-ink">
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
                      <div className="mt-0.5 truncate text-12 font-medium text-ink/75">
                        {conversation.subject}
                      </div>
                      <div className="mt-1 line-clamp-1 text-12 text-muted">
                        {conversation.snippet || "Open the thread to read the reply."}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-12 text-faint">
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
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span className="min-w-0 break-anywhere text-12 font-semibold text-ink">
                        {message.fromEmail}
                      </span>
                      <span className="text-12 text-faint">
                        {relativeTime(message.receivedAt)}
                      </span>
                    </div>
                    <div className="mt-0.5 text-12 text-muted">
                      {message.subject}
                    </div>
                    <div className="mt-1 line-clamp-2 text-12 leading-4 text-faint">
                      {truncate(message.bodyText, 200)}
                    </div>
                    <div className="mt-2"><MessageLinkActions messageId={message.id} /></div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {active === "Sent" && (
        <Card className="mt-4 overflow-hidden">
          {/* The whole outbound set is counted, never the loaded window: this tab printed the size
              of its own page as the count, so a mailbox holding 454 read "100". */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5 text-12 text-muted">
            <span className="flex items-center gap-2">
              <Send size={13} />
              {sentPage.total === 0 ? (
                <span>0 sent messages</span>
              ) : (
                <span>
                  Showing <strong className="font-bold text-ink">{sent.length}</strong> of{" "}
                  <strong className="font-bold text-ink">{sentPage.total}</strong>{" "}
                  {sentPage.total === 1 ? "sent message" : "sent messages"}
                </span>
              )}
            </span>
            <span className="text-faint">Newest first</span>
          </div>
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
                        <div className="text-12 text-faint">{message.to}</div>
                      </td>
                      <td>
                        {message.conversationId ? (
                          <Link
                            href={`/email/${message.conversationId}`}
                            className="line-clamp-1 max-w-[320px] text-12 text-ink hover:underline"
                          >
                            {message.subject}
                          </Link>
                        ) : (
                          <span className="line-clamp-1 max-w-[320px] text-12 text-ink">
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
                      <td className="text-right text-12 text-faint">
                        {formatDateTime(message.sentAt, settings.timezone)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {sentPage.hasMore && (
            <div className="flex flex-wrap items-center justify-center gap-3 border-t border-line px-4 py-3 text-12">
              <Link href={sentLoadMoreHref} className="btn-secondary btn-sm">
                Load more
              </Link>
              <span className="text-faint">
                {sentPage.total - sent.length} more not shown yet.
              </span>
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
                <option key={tag} value={tag} disabled={(draftFacets.agents[tag] ?? 0) === 0 && params.agent !== tag}>
                  {AGENT_LABELS[tag]} ({draftFacets.agents[tag] ?? 0})
                </option>
              ))}
            </select>
            <select
              name="sender"
              defaultValue={params.sender || ""}
              className="select w-auto min-w-[150px]"
              title="Which sending profile the lead is tied to"
            >
              <option value="">All senders</option>
              {accounts.map((account) => (
                <option
                  key={account.id}
                  value={account.id}
                  disabled={(draftFacets.senders[account.id] ?? 0) === 0 && params.sender !== account.id}
                >
                  {senderLabelById.get(account.id) ?? senderShortName(account)} ({draftFacets.senders[account.id] ?? 0})
                </option>
              ))}
              <option
                value="default"
                disabled={(draftFacets.senders.default ?? 0) === 0 && params.sender !== "default"}
              >
                {defaultLabel} ({draftFacets.senders.default ?? 0})
              </option>
            </select>
            <select
              name="added"
              defaultValue={params.added || ""}
              className="select w-auto min-w-[150px]"
              title={`Saved on — days are ${settings.timezone} days`}
            >
              <option value="">Any date</option>
              {COUNTED_ADDED_RANGES.map((range) => (
                <option key={range} value={range} disabled={(draftFacets.added[range] ?? 0) === 0 && params.added !== range}>
                  {ADDED_LABELS[range]} ({draftFacets.added[range] ?? 0})
                </option>
              ))}
              <option value="custom">
                {ADDED_LABELS.custom}
              </option>
            </select>
            <span className="flex items-center gap-1.5">
              <input
                type="date"
                name="from"
                defaultValue={params.from || ""}
                aria-label={`Saved from, ${settings.timezone}`}
                className="input h-10 w-auto px-3 text-13"
              />
              <span className="text-12 text-muted">to</span>
              <input
                type="date"
                name="to"
                defaultValue={params.to || ""}
                aria-label={`Saved to, ${settings.timezone}`}
                className="input h-10 w-auto px-3 text-13"
              />
            </span>
            <button type="submit" className="btn-secondary btn-sm">
              Filter
            </button>
          </form>
          {/* The total is the whole filtered set, never the loaded rows: a capped page reads
              "Showing 120 of 578", and the capped number is never presented as the count. */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5 text-12 text-muted">
            <span className="flex items-center gap-2">
              <FileText size={13} />
              {draftsTotal === 0 ? (
                <span>0 drafts</span>
              ) : (
                <span>
                  Showing <strong className="font-bold text-ink">{drafts.length}</strong> of{" "}
                  <strong className="font-bold text-ink">{draftsTotal}</strong>{" "}
                  {draftsTotal === 1 ? "draft" : "drafts"}
                </span>
              )}
            </span>
            <span className="text-faint">Sorted by most recently updated</span>
          </div>
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
              <table className="table min-w-[660px]">
                <thead>
                  <tr>
                    {/* totals 100%, sized so the UPDATED and REVIEW labels fit at 1024 too */}
                    <th className="w-[19%]">Prospect</th>
                    <th className="w-[10%]">Type</th>
                    <th className="w-[23%]">Subject</th>
                    <th className="w-[14%]">Saved by</th>
                    <th className="w-[12%]">Status</th>
                    <th className="w-[12%]">Updated</th>
                    <th className="w-[10%] text-right">Review</th>
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
                      <td className="truncate text-12">{draft.subject}</td>
                      <td>
                        <div className="flex flex-col items-start gap-1">
                          <AgentPill
                            agent={draft.sourceAgent ?? "unknown"}
                            channel={draft.sourceChannel}
                            note={draft.sourceAgent === "other" ? draft.sourceClient : undefined}
                          />
                          <SenderPill
                            profile={
                              draft.sendingProfileId
                                ? {
                                    id: draft.sendingProfileId,
                                    label:
                                      senderLabelById.get(draft.sendingProfileId) ??
                                      senderShortName(
                                        accounts.find((row) => row.id === draft.sendingProfileId) ?? {},
                                      ),
                                  }
                                : { id: null, label: defaultLabel }
                            }
                            title={draftSenderTitle(draft.sendingProfileId)}
                          />
                        </div>
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
                      <td className="text-12 text-faint">{relativeTime(draft.updatedAt)}</td>
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
          {draftPage.hasMore && (
            <div className="flex justify-center border-t border-line px-4 py-3 text-12">
              <Link href={draftLoadMoreHref} className="btn-secondary btn-sm">
                Load more drafts
              </Link>
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
                          <div className="text-12 text-faint">
                            Created {relativeTime(campaign.createdAt)}
                          </div>
                        </td>
                        <td>
                          <div className="text-12 text-ink">
                            {campaign.sent} of {campaign.total} sent
                          </div>
                          <div className="text-12 text-faint">
                            {campaign.failed} failed · {campaign.queued} queued
                          </div>
                        </td>
                        <td>
                          <span className="badge capitalize">{campaign.status}</span>
                        </td>
                        <td className="text-12 text-muted">{campaign.accountEmail}</td>
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
                <div className="text-28 leading-none">{value}</div>
                <div className="mt-1 text-12 font-bold uppercase tracking-[0.12em] text-faint">
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
            </div>
            {/* The true total, never the window: the same fault the Leads page had. */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-12 text-muted">
              <span className="flex items-center gap-2">
                <MessageSquare size={13} />
                {followDraftPage.total === 0 ? (
                  <span>0 follow-up drafts</span>
                ) : (
                  <span>
                    Showing <strong className="font-bold text-ink">{followDrafts.length}</strong> of{" "}
                    <strong className="font-bold text-ink">{followDraftPage.total}</strong>{" "}
                    {followDraftPage.total === 1 ? "follow-up draft" : "follow-up drafts"}
                  </span>
                )}
              </span>
              <span className="text-faint">Drafts first, then approved</span>
            </div>
            {followDrafts.length === 0 ? (
              <EmptyState
                icon="inbox"
                title="No follow-ups prepared"
                description="Once a contacted thread passes the configured waiting period without a reply, its personalized follow-up can be prepared here."
              />
            ) : (
              <FollowUpDraftList drafts={followDrafts} sandbox={sandbox} />
            )}
            {followDraftPage.hasMore && (
              <div className="mt-4 flex flex-wrap items-center justify-center gap-3 text-12">
                <Link href={followUpLoadMoreHref} className="btn-secondary btn-sm">
                  Load more
                </Link>
                <span className="text-faint">
                  {followDraftPage.total - followDrafts.length} more not shown yet.
                </span>
              </div>
            )}
          </Card>
          <Card className="p-5">
            <SectionHeading
              title="Eligible but not yet prepared"
              description={`${unpreparedFollowUps.length} due and not yet prepared. Preparing creates drafts only; sending still needs founder review.`}
            />
            <FollowUpEligibleList
              dailyLimit={settings.followUpDailyLimit}
              candidates={unpreparedFollowUps.map((candidate) => ({
                conversationId: candidate.conversationId,
                prospectId: candidate.prospectId,
                businessName: candidate.businessName,
                daysSinceLastOutbound: candidate.daysSinceLastOutbound,
                nextSequence: candidate.nextSequence,
              }))}
            />
          </Card>
        </div>
      )}
    </div>
  );
}
