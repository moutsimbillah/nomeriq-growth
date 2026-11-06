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
  Reply,
  Search,
} from "lucide-react";
import { getFolderInbox, isInboxFolder, type InboxFolder, type InboxRow } from "@/lib/services/inbox";
import { folderDefinition, foldersByGroup, type FolderGroup } from "@/lib/services/folders";
import { getConversation, messageBodyForDisplay } from "@/lib/services/conversations";
import { listDraftsForProspect } from "@/lib/services/drafts";
import { listEmailAccounts } from "@/lib/email/accounts";
import { defaultSenderLabel, senderLabels, senderShortName } from "@/lib/email/senderPill";
import { getWorkspaceSettings } from "@/lib/services/settings";
import { draftProvenance } from "@/lib/ai/provenance";
import { translationOffered } from "@/lib/ai/language-detect";
import { AgentPill, Card, SenderPill } from "@/components/ui";
import { ConversationMessage } from "@/components/conversation-message";
import { PIPELINE_LABELS } from "@/lib/types";
import { AGENT_LABELS } from "@/lib/agent/agentTag";
import { cn } from "@/lib/cn";
import { formatDateTime, relativeTime, truncate } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * The folder inbox — email item 2, design stage. Three panes: folders grouped Active / Outcomes /
 * Problems with counts over all leads; the list for the selected folder, newest first, with search,
 * sender and agent filters and pills; the selected lead's thread. State lives in the URL, so every
 * view is a link. At phone width the panes stack: folders as a scroller, then the list, and a
 * selected thread replaces the list with a Back link.
 */

const GROUP_TITLE: Record<FolderGroup, string> = { Active: "Active", Outcome: "Outcomes", Problem: "Problems" };

type Params = { folder?: string; c?: string; q?: string; sender?: string; agent?: string; limit?: string };

function href(base: Params, change: Partial<Params>): string {
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...base, ...change })) {
    if (value) next.set(key, value);
  }
  const query = next.toString();
  return `/email/folders${query ? `?${query}` : ""}`;
}

function folderLabel(folder: InboxFolder): string {
  return folder === "archived" ? "Archived" : folderDefinition(folder).label;
}

export default async function FolderInboxPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const limit = Number.parseInt(params.limit ?? "", 10);
  const [inbox, accounts, settings] = await Promise.all([
    getFolderInbox({
      folder: isInboxFolder(params.folder) ? params.folder : null,
      query: params.q,
      sender: params.sender,
      agent: params.agent,
      limit: Number.isFinite(limit) ? limit : undefined,
    }),
    listEmailAccounts(),
    getWorkspaceSettings(),
  ]);
  const base: Params = { folder: inbox.folder, q: params.q, sender: params.sender, agent: params.agent };
  const selected = params.c ? inbox.rows.find((row) => row.prospectId === params.c) ?? null : null;

  const senderLabelById = senderLabels(accounts);
  const defaultProfile = accounts.find((account) => account.isDefault) ?? accounts[0] ?? null;
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
  const totalLeads = Object.entries(inbox.counts).filter(([key]) => key !== "archived").reduce((n, [, v]) => n + v, 0);

  return (
    <div className="animate-fade-up" data-folder-inbox>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-12 font-bold uppercase tracking-[0.15em] text-faint">Email · folder inbox</div>
          <h1 className="mt-1 text-28 font-bold leading-tight tracking-[-0.02em] text-ink">{folderLabel(inbox.folder)}</h1>
          <p className="mt-0.5 text-12 text-muted" data-folder-rule>
            {inbox.folder === "archived" ? "Archived leads are kept out of every folder." : folderDefinition(inbox.folder).rule}
            <span className="text-faint"> · {totalLeads} leads across the eleven folders, each in exactly one</span>
          </p>
        </div>
        <Link href="/email" className="btn-ghost btn-sm">
          <ArrowLeft size={12} /> Current Email page
        </Link>
      </div>

      {/* Phone: folders as one horizontal scroller. */}
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
      </nav>

      <div className="grid gap-3 lg:grid-cols-[188px_minmax(0,300px)_minmax(0,1fr)]">
        {/* Left: folders grouped Active, Outcomes, Problems. */}
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
          </Card>
        </aside>

        {/* Middle: search, filters and the list. Hidden on a phone while a thread is open. */}
        <section className={cn("min-w-0", selected && "hidden lg:block")} aria-label="Leads in this folder" data-list-pane>
          <Card className="overflow-hidden">
            <form action="/email/folders" className="space-y-2 border-b border-line p-2.5">
              <input type="hidden" name="folder" value={inbox.folder} />
              <label className="flex items-center gap-2 rounded-lg border border-line bg-white px-2.5 py-1.5">
                <Search size={12} className="text-faint" />
                <input name="q" defaultValue={params.q ?? ""} placeholder="Search name, domain or email" className="min-w-0 flex-1 bg-transparent text-12 outline-none" />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <select name="sender" defaultValue={params.sender ?? ""} className="select h-8 text-12" aria-label="Sender">
                  <option value="">All senders</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>{senderLabelById.get(account.id) ?? account.emailAddress}</option>
                  ))}
                  <option value="none">No sender yet</option>
                </select>
                <select name="agent" defaultValue={params.agent ?? ""} className="select h-8 text-12" aria-label="Agent">
                  <option value="">All agents</option>
                  {Object.entries(AGENT_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </div>
              <button type="submit" className="btn-secondary btn-xs w-full">Apply</button>
            </form>
            <div className="flex items-center justify-between px-3 py-2 text-12 text-muted">
              <span>
                <strong className="text-ink">{inbox.rows.length}</strong> of <strong className="text-ink">{inbox.total}</strong> · newest first
              </span>
            </div>
            {inbox.rows.length === 0 ? (
              <div className="px-4 py-10 text-center text-12 text-faint">
                <Inbox size={18} className="mx-auto mb-2" /> Nothing in {folderLabel(inbox.folder)}.
              </div>
            ) : (
              <ul className="divide-y divide-line" data-lead-list>
                {inbox.rows.map((row) => (
                  <ListRow key={row.prospectId} row={row} active={row.prospectId === selected?.prospectId}
                    link={href(base, { c: row.prospectId, limit: params.limit })} sender={senderPill(row.sendingProfileId)} />
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

        {/* Right: the selected lead. */}
        <section className={cn("min-w-0", !selected && "hidden lg:block")} aria-label="Conversation" data-thread-pane>
          {!selected ? (
            <Card className="grid min-h-[320px] place-items-center p-6 text-center">
              <div>
                <Reply size={18} className="mx-auto mb-2 text-faint" />
                <p className="text-13 font-semibold text-ink">Choose a lead</p>
                <p className="mt-1 text-12 text-muted">Its thread, stage and reply box open here.</p>
              </div>
            </Card>
          ) : (
            <Card className="overflow-hidden">
              <div className="border-b border-line p-3.5">
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
                  <span className="badge border-forest/20 bg-lime/20 text-forest">{folderLabel(selected.folder)}</span>
                  <AgentPill agent={selected.sourceAgent ?? "unknown"} channel={selected.sourceChannel} note={selected.sourceAgent === "other" ? selected.sourceClient : undefined} />
                  <SenderPill profile={senderPill(selected.sendingProfileId)} />
                </div>
              </div>

              <div className="max-h-[560px] space-y-3 overflow-y-auto bg-paper/30 p-3.5" data-thread>
                {conversation ? (
                  // Chat order: oldest at the top, the latest message just above the reply box.
                  [...conversation.messages].reverse().map((message, index, list) => {
                    const inbound = message.direction === "inbound";
                    const body = messageBodyForDisplay(message);
                    return (
                      <div key={message.id} className={cn("flex", inbound ? "justify-start" : "justify-end")}>
                        <div className="w-full sm:w-[92%]">
                          <ConversationMessage
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
                            latest={index === list.length - 1 && inbound}
                          />
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p className="py-6 text-center text-12 text-muted">No email exchanged with this lead yet.</p>
                )}
              </div>

              <div className="border-t border-line p-3.5" data-reply-area>
                {waitingDraft ? (
                  <div className="rounded-lg border border-line bg-white/70 p-3">
                    <div className="flex flex-wrap items-center gap-2 text-12 font-bold text-ink">
                      <FileText size={12} />
                      {waitingDraft.kind === "follow_up" ? `Follow-up #${waitingDraft.sequence}` : "First email"} waiting for your Send
                      <span className="badge capitalize">{waitingDraft.status}</span>
                    </div>
                    <p className="mt-1 text-12 font-semibold text-ink">{waitingDraft.subject}</p>
                    <p className="mt-0.5 whitespace-pre-wrap text-12 leading-5 text-muted">{truncate(waitingDraft.body, 420)}</p>
                    <p className="mt-1 text-12 text-faint">{draftProvenance(waitingDraft)}</p>
                    <Link href={`/leads/${selected.prospectId}`} className="btn-primary btn-xs mt-2">Review and send</Link>
                  </div>
                ) : conversation && selected.folder === "needs_reply" ? (
                  <div className="rounded-lg border border-line bg-white/70 p-3">
                    <div className="text-12 font-bold text-ink">Reply</div>
                    <p className="mt-0.5 text-12 text-muted">The reply box with an AI suggestion ready to edit opens here once this view is wired.</p>
                    <Link href={`/email/${selected.conversationId}`} className="btn-primary btn-xs mt-2"><Reply size={11} /> Reply</Link>
                  </div>
                ) : (
                  <p className="flex items-center gap-1.5 text-12 text-muted">
                    <CircleCheck size={12} /> {nextStep(selected)}
                  </p>
                )}
              </div>
            </Card>
          )}
        </section>
      </div>
    </div>
  );
}

function nextStep(row: InboxRow): string {
  switch (row.folder) {
    case "waiting": return `Sent ${relativeTime(row.lastOutboundAt)} — no reply yet. Follow-ups are prepared in the Follow-ups list.`;
    case "new_leads": return "Not contacted yet. Write the first email from the lead card.";
    case "in_conversation": return "Your message was the last one. Waiting for their answer.";
    case "meeting": return "Meeting or proposal stage. Next step is yours.";
    case "opted_out": return "Opted out. Never contacted again.";
    case "failed": return "A delivery bounced. The address is suppressed.";
    case "won": return "Won.";
    case "closed_lost": return "Closed (lost).";
    case "archived": return "Archived. Not in any folder.";
    default: return "";
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
    <li>
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
    </li>
  );
}
