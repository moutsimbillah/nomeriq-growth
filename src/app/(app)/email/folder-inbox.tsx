import Link from "next/link";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowRight,
  Building2,
  CircleCheck,
  FileText,
  Inbox,
  Mail,
  Reply,
  Wrench,
} from "lucide-react";
import { getFolderInbox, isInboxFolder, type InboxFolder, type InboxRow } from "@/lib/services/inbox";
import { folderDefinition, foldersByGroup, type FolderGroup } from "@/lib/services/folders";
import { getConversation, messageBodyForDisplay } from "@/lib/services/conversations";
import { listDraftsForProspect } from "@/lib/services/drafts";
import { getDefaultEmailAccount, listEmailAccounts } from "@/lib/email/accounts";
import { defaultSenderLabel, senderLabels, senderShortName } from "@/lib/email/senderPill";
import { getWorkspaceSettings } from "@/lib/services/settings";
import { draftProvenance } from "@/lib/ai/provenance";
import { translationOffered } from "@/lib/ai/language-detect";
import { AgentPill, Card, SenderPill } from "@/components/ui";
import { ConversationMessage } from "@/components/conversation-message";
import { MarkConversationRead, ReplyComposer } from "@/components/conversation-actions";
import { SyncMailboxButton } from "@/components/sync-mailbox-button";
import { ApproveSelectionList, InboxFilters, StageButtons } from "@/components/folder-inbox-client";
import { PIPELINE_LABELS } from "@/lib/types";
import { AGENT_LABELS } from "@/lib/agent/agentTag";
import { cn } from "@/lib/cn";
import { formatDateTime, relativeTime, truncate } from "@/lib/utils";

/**
 * The folder inbox — the main Email screen (email item 2). Three panes: folders grouped Active /
 * Outcomes / Problems with counts over all leads, plus a Tools group (Sent, Drafts, Campaigns,
 * Follow-ups, the mailbox list); the list for the selected folder, newest first, with search and
 * sender/agent filters; the selected lead — stage buttons, reply box with an AI suggestion, and the
 * thread newest first like the conversation page. State lives in the URL, so every view is a link.
 * At phone width: folder and tool chips, then the list; an open lead replaces the list with Back.
 */

const GROUP_TITLE: Record<FolderGroup, string> = { Active: "Active", Outcome: "Outcomes", Problem: "Problems" };

/** The older tabs, still one click away: `/email?tab=…` keeps every existing link working. */
export const EMAIL_TOOLS = [
  { href: "/email?tab=sent", label: "Sent" },
  { href: "/email?tab=drafts", label: "Drafts" },
  { href: "/email?tab=campaigns", label: "Campaigns" },
  { href: "/email?tab=followups", label: "Follow-ups" },
  { href: "/email?tab=inbox", label: "Mailbox list" },
] as const;

export type FolderInboxParams = { folder?: string; c?: string; q?: string; sender?: string; agent?: string; limit?: string };

function href(base: FolderInboxParams, change: Partial<FolderInboxParams>): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...base, ...change })) {
    if (value) next.set(key, value);
  }
  const query = next.toString();
  return `/email${query ? `?${query}` : ""}`;
}

function folderLabel(folder: InboxFolder): string {
  return folder === "archived" ? "Archived" : folderDefinition(folder).label;
}

export async function FolderInbox({ params }: { params: FolderInboxParams }) {
  const limit = Number.parseInt(params.limit ?? "", 10);
  const [inbox, accounts, settings, account] = await Promise.all([
    getFolderInbox({
      folder: isInboxFolder(params.folder) ? params.folder : null,
      query: params.q,
      sender: params.sender,
      agent: params.agent,
      limit: Number.isFinite(limit) ? limit : undefined,
      focus: params.c,
    }),
    listEmailAccounts(),
    getWorkspaceSettings(),
    getDefaultEmailAccount().catch(() => null),
  ]);
  const base: FolderInboxParams = { folder: inbox.folder, q: params.q, sender: params.sender, agent: params.agent };
  const selected = inbox.focused;
  const sandbox =
    (process.env.EMAIL_DELIVERY_MODE || "sandbox").toLowerCase() !== "live" || account?.provider === "sandbox";

  const senderLabelById = senderLabels(accounts);
  const defaultProfile = accounts.find((row) => row.isDefault) ?? accounts[0] ?? null;
  const senderPill = (id: string | null) =>
    id
      ? { id, label: senderLabelById.get(id) ?? senderShortName(accounts.find((a) => a.id === id) ?? {}) }
      : { id: null, label: defaultSenderLabel(defaultProfile) };

  const [conversation, drafts] = selected
    ? await Promise.all([
        selected.conversationId ? getConversation(selected.conversationId) : Promise.resolve(null),
        listDraftsForProspect(selected.prospectId),
      ])
    : [null, []];
  const waitingDraft = drafts.find((draft) => draft.status === "draft" || draft.status === "approved") ?? null;
  // Messages arrive newest first, the same order the conversation page shows.
  const messages = conversation?.messages ?? [];
  const lastInbound = messages.find((message) => message.direction === "inbound");
  const defaultSubject = lastInbound?.subject?.toLowerCase().startsWith("re:")
    ? lastInbound.subject
    : `Re: ${lastInbound?.subject || conversation?.subject || ""}`;
  const totalLeads = Object.entries(inbox.counts).filter(([key]) => key !== "archived").reduce((n, [, v]) => n + v, 0);

  const rowLink = (row: InboxRow) => href(base, { c: row.prospectId, limit: params.limit });

  return (
    <div className="animate-fade-up" data-folder-inbox>
      {conversation && selected && selected.unread > 0 && <MarkConversationRead key={conversation.id} conversationId={conversation.id} />}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-12 font-bold uppercase tracking-[0.15em] text-faint">Email</div>
          <h1 className="mt-1 text-28 font-bold leading-tight tracking-[-0.02em] text-ink">{folderLabel(inbox.folder)}</h1>
          <p className="mt-0.5 text-12 text-muted" data-folder-rule>
            {inbox.folder === "archived" ? "Archived leads are kept out of every folder." : folderDefinition(inbox.folder).rule}
            <span className="text-faint"> · {totalLeads} leads, each in exactly one folder</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {account && (
            <span className="flex items-center gap-1.5 text-12 text-muted">
              <Mail size={12} className={account.status === "connected" ? "text-forest" : "text-amber"} />
              <span className="font-semibold text-ink">{account.emailAddress}</span>
              {account.provider === "sandbox" && <span className="badge border-amber/20 bg-amber/[0.07] text-amber">sandbox</span>}
            </span>
          )}
          {account && account.provider !== "sandbox" && <SyncMailboxButton accountId={account.id} />}
        </div>
      </div>

      {/* Phone: folders, then the tools, as one horizontal scroller. */}
      <nav className="-mx-1 mb-3 flex gap-1.5 overflow-x-auto px-1 pb-1 lg:hidden" aria-label="Folders" data-folder-scroller>
        {foldersByGroup().flatMap(({ folders }) => folders).map((folder) => (
          <Link
            key={folder.key}
            href={href(base, { folder: folder.key, c: undefined, limit: undefined })}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1.5 text-12 font-semibold",
              folder.key === inbox.folder ? "border-forest bg-forest text-lime" : "border-line bg-white/60 text-ink",
            )}
          >
            {folder.label} <span className="opacity-70">{inbox.counts[folder.key]}</span>
          </Link>
        ))}
        <span className="mx-1 w-px shrink-0 bg-line" aria-hidden />
        {EMAIL_TOOLS.map((tool) => (
          <Link key={tool.href} href={tool.href} className="shrink-0 rounded-full border border-dashed border-line px-3 py-1.5 text-12 font-semibold text-muted">
            {tool.label}
          </Link>
        ))}
      </nav>

      <div className="grid gap-3 lg:grid-cols-[188px_minmax(0,300px)_minmax(0,1fr)]">
        {/* Left: folders grouped Active, Outcomes, Problems; then Archived and the Tools. */}
        <aside className="hidden lg:block" aria-label="Folders" data-folder-pane>
          <Card className="p-2">
            {foldersByGroup().map(({ group, folders }) => (
              <div key={group} className="mb-2 last:mb-0">
                <div className="px-2 pb-1 pt-2 text-12 font-bold uppercase tracking-[0.12em] text-faint">
                  {GROUP_TITLE[group]}
                </div>
                {folders.map((folder) => {
                  const active = folder.key === inbox.folder;
                  const count = inbox.counts[folder.key];
                  return (
                    <Link
                      key={folder.key}
                      href={href(base, { folder: folder.key, c: undefined, limit: undefined })}
                      title={folder.rule}
                      data-folder={folder.key}
                      className={cn(
                        "flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-12",
                        active ? "bg-forest text-lime" : count ? "text-ink hover:bg-ink/[0.04]" : "text-faint hover:bg-ink/[0.04]",
                      )}
                    >
                      <span className="flex min-w-0 items-center gap-1.5 truncate font-semibold">
                        {group === "Problem" && <AlertTriangle size={11} />}
                        {folder.label}
                      </span>
                      <span className={cn("tabular-nums", active ? "text-lime" : "text-muted")}>{count}</span>
                    </Link>
                  );
                })}
              </div>
            ))}
            <Link
              href={href(base, { folder: "archived", c: undefined, limit: undefined })}
              className={cn(
                "mt-1 flex items-center justify-between rounded-lg border-t border-line px-2 py-1.5 text-12",
                inbox.folder === "archived" ? "bg-forest text-lime" : "text-muted hover:bg-ink/[0.04]",
              )}
            >
              <span className="flex items-center gap-1.5"><Archive size={11} /> Archived</span>
              <span className="tabular-nums">{inbox.counts.archived}</span>
            </Link>
            <div className="mt-2 border-t border-line pt-1" data-email-tools>
              <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-12 font-bold uppercase tracking-[0.12em] text-faint">
                <Wrench size={10} /> Tools
              </div>
              {EMAIL_TOOLS.map((tool) => (
                <Link key={tool.href} href={tool.href} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-12 font-semibold text-muted hover:bg-ink/[0.04] hover:text-ink">
                  {tool.label}
                  <ArrowRight size={10} className="text-faint" />
                </Link>
              ))}
            </div>
          </Card>
        </aside>

        {/* Middle: search, filters and the list. Hidden on a phone while a lead is open. */}
        <section className={cn("min-w-0", selected && "hidden lg:block")} aria-label="Leads in this folder" data-list-pane>
          <Card className="overflow-hidden">
            <InboxFilters
              key={`${base.folder}|${base.q ?? ""}`}
              base={{ folder: inbox.folder, q: params.q, sender: params.sender, agent: params.agent }}
              senders={accounts.map((row) => ({ id: row.id, label: senderLabelById.get(row.id) ?? row.emailAddress }))}
              agents={Object.entries(AGENT_LABELS).map(([key, label]) => ({ key, label }))}
            />
            <div className="px-3 py-2 text-12 text-muted">
              <strong className="text-ink">{inbox.rows.length}</strong> of <strong className="text-ink">{inbox.total}</strong> · newest first
            </div>
            {inbox.rows.length === 0 ? (
              <div className="px-4 py-10 text-center text-12 text-faint">
                <Inbox size={18} className="mx-auto mb-2" /> Nothing in {folderLabel(inbox.folder)}.
              </div>
            ) : inbox.folder === "to_approve" ? (
              <ApproveSelectionList
                items={inbox.rows.map((row) => ({
                  prospectId: row.prospectId,
                  draftId: row.draftWaiting?.id ?? null,
                  approvable: row.draftWaiting?.status === "draft",
                  row: <ListRow row={row} active={row.prospectId === selected?.prospectId} link={rowLink(row)} sender={senderPill(row.sendingProfileId)} />,
                }))}
              />
            ) : (
              <ul className="divide-y divide-line" data-lead-list>
                {inbox.rows.map((row) => (
                  <li key={row.prospectId}>
                    <ListRow row={row} active={row.prospectId === selected?.prospectId} link={rowLink(row)} sender={senderPill(row.sendingProfileId)} />
                  </li>
                ))}
              </ul>
            )}
            {inbox.hasMore && (
              <div className="border-t border-line p-2.5 text-center">
                <Link href={href(base, { limit: String(inbox.limit + 50) })} className="btn-secondary btn-xs">Load more</Link>
              </div>
            )}
          </Card>
        </section>

        {/* Right: the open lead. */}
        <section className={cn("min-w-0", !selected && "hidden lg:block")} aria-label="Conversation" data-thread-pane>
          {!selected ? (
            <Card className="grid min-h-[320px] place-items-center p-6 text-center">
              <div>
                <Reply size={18} className="mx-auto mb-2 text-faint" />
                <p className="text-13 font-semibold text-ink">Choose a lead</p>
                <p className="mt-1 text-12 text-muted">Its stage, reply box and thread open here.</p>
              </div>
            </Card>
          ) : (
            <div className="space-y-3">
              <Card className="p-3.5">
                <Link href={href(base, { c: undefined })} className="mb-2 inline-flex items-center gap-1 text-12 text-muted lg:hidden">
                  <ArrowLeft size={11} /> {folderLabel(inbox.folder)}
                </Link>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-16 font-bold text-ink">{selected.businessName}</h2>
                    <p className="break-anywhere text-12 text-muted">
                      {selected.contactEmail ?? "No contact email"}{selected.domain ? ` · ${selected.domain}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <Link href={`/leads/${selected.prospectId}`} className="btn-secondary btn-xs"><Building2 size={11} /> Lead card</Link>
                    {selected.conversationId && (
                      <Link href={`/email/${selected.conversationId}`} className="btn-ghost btn-xs">Full thread <ArrowRight size={10} /></Link>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="badge" data-stage>Stage: {PIPELINE_LABELS[selected.status as keyof typeof PIPELINE_LABELS] ?? selected.status}</span>
                  <span className="badge border-forest/20 bg-lime/20 text-forest" data-open-folder>{folderLabel(selected.folder)}</span>
                  <AgentPill agent={selected.sourceAgent ?? "unknown"} channel={selected.sourceChannel} note={selected.sourceAgent === "other" ? selected.sourceClient : undefined} />
                  <SenderPill profile={senderPill(selected.sendingProfileId)} />
                </div>
                {selected.folder !== "archived" && (
                  <div className="mt-3 border-t border-line pt-3">
                    <StageButtons key={`${selected.prospectId}:${selected.status}`} prospectId={selected.prospectId} status={selected.status} />
                  </div>
                )}
              </Card>

              <div data-reply-area>
                {waitingDraft && (
                  <Card className="mb-3 p-3.5">
                    <div className="flex flex-wrap items-center gap-2 text-12 font-bold text-ink">
                      <FileText size={12} />
                      {waitingDraft.kind === "follow_up" ? `Follow-up #${waitingDraft.sequence}` : "First email"} waiting for your Send
                      <span className="badge capitalize">{waitingDraft.status}</span>
                    </div>
                    <p className="mt-1 text-12 font-semibold text-ink">{waitingDraft.subject}</p>
                    <p className="mt-0.5 whitespace-pre-wrap text-12 leading-5 text-muted">{truncate(waitingDraft.body, 420)}</p>
                    <p className="mt-1 text-12 text-faint">{draftProvenance(waitingDraft)}</p>
                    <Link href={`/leads/${selected.prospectId}`} className="btn-primary btn-xs mt-2">Review and send</Link>
                  </Card>
                )}
                {conversation && lastInbound ? (
                  <ReplyComposer
                    key={conversation.id}
                    conversationId={conversation.id}
                    defaultSubject={defaultSubject}
                    recipient={conversation.replyTo}
                    suppressed={conversation.suppressed}
                    blockedReason={conversation.blockedReason}
                    sandbox={sandbox}
                  />
                ) : (
                  !waitingDraft && (
                    <Card className="p-3.5">
                      <p className="flex items-center gap-1.5 text-12 text-muted"><CircleCheck size={12} /> {nextStep(selected)}</p>
                    </Card>
                  )
                )}
              </div>

              <div className="space-y-3" data-thread>
                {messages.length === 0 ? (
                  <p className="py-4 text-center text-12 text-muted">No email exchanged with this lead yet.</p>
                ) : (
                  messages.map((message, index) => {
                    const inbound = message.direction === "inbound";
                    const body = messageBodyForDisplay(message);
                    return (
                      <ConversationMessage
                        key={message.id}
                        messageId={message.id}
                        inbound={inbound}
                        fromName={message.fromName}
                        fromEmail={message.fromEmail}
                        subject={message.subject}
                        bodyKind={body.kind}
                        originalText={body.text}
                        isSandbox={message.isSandbox}
                        external={message.external}
                        deliveryStatus={message.deliveryStatus}
                        timeLabel={formatDateTime(message.receivedAt || message.sentAt, settings.timezone)}
                        attachments={message.attachments}
                        translation={message.translation ?? null}
                        offersTranslation={translationOffered({
                          direction: message.direction,
                          text: body.kind === "pending" ? "" : body.text,
                          cachedStatus: message.translation?.status ?? null,
                        })}
                        latest={index === 0 && inbound}
                      />
                    );
                  })
                )}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function nextStep(row: InboxRow): string {
  switch (row.folder) {
    case "waiting": return `Sent ${relativeTime(row.lastOutboundAt)} — no reply yet. Follow-ups are prepared from Tools → Follow-ups.`;
    case "new_leads": return "Not contacted yet. Write the first email from the lead card.";
    case "in_conversation": return "Your message was the last one. Waiting for their answer.";
    case "meeting": return "Meeting or proposal stage. Next step is yours.";
    case "opted_out": return "Opted out. Never contacted again.";
    case "on_hold": return "On hold: you marked this lead do-not-contact. Clear it on the lead card to resume.";
    case "failed": return "A delivery bounced. The address is suppressed.";
    case "won": return "Won.";
    case "closed_lost": return "Closed (lost).";
    case "archived": return "Archived. Not in any folder.";
    default: return "Nothing waiting on you.";
  }
}

function ListRow({ row, active, link, sender }: {
  row: InboxRow;
  active: boolean;
  link: string;
  sender: { id: string | null; label: string | null };
}) {
  const waitingSince = row.folder === "needs_reply" ? row.lastInboundAt : null;
  const overDay = waitingSince ? Date.now() - Date.parse(waitingSince) > 86_400_000 : false;
  return (
    <Link href={link} data-lead-row={row.prospectId}
      className={cn("block px-3 py-2.5 transition", active ? "bg-forest/[0.07]" : "hover:bg-ink/[0.025]")}>
      <div className="flex items-start justify-between gap-2">
        <span className={cn("min-w-0 truncate text-13 text-ink", row.unread > 0 ? "font-bold" : "font-semibold")}>
          {row.businessName}
        </span>
        <span className="shrink-0 text-12 text-faint">{row.lastActivityAt ? relativeTime(row.lastActivityAt) : ""}</span>
      </div>
      <div className="mt-0.5 truncate text-12 text-muted">
        {row.snippet
          ? `${row.snippetDirection === "inbound" ? "" : "You: "}${row.snippet}`
          : row.draftWaiting
            ? `${row.draftWaiting.kind === "follow_up" ? `Follow-up #${row.draftWaiting.sequence}` : "First email"} ${row.draftWaiting.status === "approved" ? "approved" : "drafted"}, not sent`
            : row.subject ?? row.contactEmail ?? ""}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {/* Tier and product-fit pills go first here when those fields exist (later phase). */}
        <span className="contents" data-qualification-pills />
        <SenderPill profile={sender} />
        <AgentPill agent={row.sourceAgent ?? "unknown"} channel={row.sourceChannel} note={row.sourceAgent === "other" ? row.sourceClient : undefined} />
        {row.unread > 0 && <span className="badge border-forest bg-forest text-lime">{row.unread} unread</span>}
        {waitingSince && (
          <span className={cn("badge", overDay ? "border-rust/30 bg-rust/[0.06] text-rust" : "")} data-wait>
            waiting {relativeTime(waitingSince).replace(/ ago$/, "")}
          </span>
        )}
      </div>
    </Link>
  );
}
