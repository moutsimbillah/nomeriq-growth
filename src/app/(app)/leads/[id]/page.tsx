import Link from "next/link";
import { notFound } from "next/navigation";
import { AGENT_LABELS, CHANNEL_LABELS } from "@/lib/agent/agentTag";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Building2,
  CalendarDays,
  CheckCircle2,
  CircleDashed,
  Clock3,
  ExternalLink,
  Globe2,
  History,
  Camera,
  Mail,
  MapPin,
  MessageSquare,
  MonitorPlay,
  ShieldCheck,
} from "lucide-react";
import {
  getProspect,
} from "@/lib/services/prospects";
import {
  getFirstContactDraft,
  listDraftsForProspect,
} from "@/lib/services/drafts";
import { getConversationForProspect } from "@/lib/services/conversations";
import { getDefaultEmailAccount } from "@/lib/email/accounts";
import { getWorkspaceSettings } from "@/lib/services/settings";
import {
  Card,
  CategoryPill,
  DataRow,
  PageHeader,
  SectionHeading,
} from "@/components/ui";
import {
  AddSourceButton,
  ArchiveLeadButton,
  DraftEditor,
  PipelineCard,
} from "@/components/lead-actions";
import { formatDate, formatDateTime, relativeTime } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const prospect = await getProspect(id);
  if (!prospect) notFound();

  const [draft, conversation, drafts, account, settings] = await Promise.all([
    getFirstContactDraft(id),
    getConversationForProspect(id),
    listDraftsForProspect(id),
    getDefaultEmailAccount().catch(() => null),
    getWorkspaceSettings(),
  ]);
  const envSandbox = (process.env.EMAIL_DELIVERY_MODE || "sandbox").toLowerCase() !== "live";
  const sandboxMode = envSandbox || account?.provider === "sandbox";
  const followUps = drafts.filter((item) => item.kind === "follow_up");
  const blockedReasons: string[] = [];
  if (!account) blockedReasons.push("No email account is connected in Settings.");
  else if (account.status !== "connected")
    blockedReasons.push(
      account.lastError || "The connected mailbox is not healthy.",
    );
  if (!sandboxMode && !settings.postalAddress.trim())
    blockedReasons.push(
      "Add the registered business postal address in Settings before live sending.",
    );
  if (prospect.doNotContact)
    blockedReasons.push("This prospect is marked do not contact.");

  const socialLinks = [
    prospect.instagramUrl && {
      label: "Instagram",
      url: prospect.instagramUrl,
      icon: Camera,
    },
    prospect.youtubeUrl && {
      label: "YouTube",
      url: prospect.youtubeUrl,
      icon: MonitorPlay,
    },
    prospect.xUrl && { label: "X", url: prospect.xUrl, icon: ExternalLink },
    prospect.telegramUrl && {
      label: "Telegram",
      url: prospect.telegramUrl,
      icon: MessageSquare,
    },
    prospect.linkedinUrl && {
      label: "LinkedIn",
      url: prospect.linkedinUrl,
      icon: Building2,
    },
    ...prospect.otherSocials.map((social) => ({
      label: social.label,
      url: social.url,
      icon: Globe2,
    })),
  ].filter(Boolean) as {
    label: string;
    url: string;
    icon: typeof Camera;
  }[];

  return (
    <div className="animate-fade-up">
      <div className="mb-5 flex items-center gap-2 text-[10.5px] text-faint">
        <Link href="/leads" className="inline-flex items-center gap-1 hover:text-ink">
          <ArrowLeft size={11} /> All leads
        </Link>
        <span>/</span>
        <span className="text-muted">{prospect.businessName}</span>
      </div>

      <PageHeader
        eyebrow={`${prospect.country || "Country unknown"} · discovered ${formatDate(prospect.createdAt)}`}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {prospect.businessName}
            {prospect.qualificationStatus === "verified" && (
              <span className="inline-flex translate-y-1 items-center gap-1 rounded-full border border-forest/15 bg-lime/35 px-2.5 py-1 text-[9px] font-bold uppercase tracking-[0.1em] text-forest">
                <BadgeCheck size={11} /> Verified business
              </span>
            )}
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            {prospect.categories.map((category) => (
              <CategoryPill key={category} category={category} />
            ))}
            {prospect.websiteUrl && (
              <a
                href={prospect.websiteUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted hover:text-ink"
              >
                {prospect.domainKey} <ExternalLink size={10} />
              </a>
            )}
          </span>
        }
        actions={
          <>
            <AddSourceButton prospectId={prospect.id} />
            {conversation && (
              <Link href={`/email/${conversation.id}`} className="btn-secondary">
                <MessageSquare size={13} />
                Open conversation
              </Link>
            )}
            <ArchiveLeadButton prospectId={prospect.id} />
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[1.45fr_1fr] [&>*]:min-w-0">
        <div className="space-y-4">
          <Card className="p-5">
            <SectionHeading
              title="Contact and verification"
              description="A counted lead has a public source, not a guessed pattern."
            />
            <div className="mt-4 rounded-xl border border-line bg-paper/50 p-4">
              {prospect.contactEmail ? (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="grid h-8 w-8 place-items-center rounded-full bg-lime/35 text-forest">
                        <Mail size={14} />
                      </span>
                      <div>
                        <div className="wrap-anywhere text-[14px] font-semibold text-ink">
                          {prospect.contactEmail}
                        </div>
                        <div className="mt-0.5 text-[9.5px] uppercase tracking-[0.1em] text-faint">
                          Public business contact
                        </div>
                      </div>
                    </div>
                    <a
                      href={`mailto:${prospect.contactEmail}`}
                      className="btn-secondary btn-xs"
                    >
                      <Mail size={11} /> Compose externally
                    </a>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted">
                    <span className="inline-flex items-center gap-1">
                      <ShieldCheck size={10} className="text-forest" />
                      Verified {prospect.verifiedAt ? formatDate(prospect.verifiedAt) : "date unknown"}
                        {prospect.sourceAgent
                          ? ` · Found by ${AGENT_LABELS[prospect.sourceAgent]}${
                              prospect.sourceChannel ? ` via ${CHANNEL_LABELS[prospect.sourceChannel]}` : ""
                            }`
                          : prospect.sourceClient
                            ? ` · saved by ${prospect.sourceClient}`
                            : ""}
                    </span>
                    {prospect.contactEmailSource && (
                      <a
                        href={prospect.contactEmailSource}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1 font-semibold text-ink underline decoration-line-strong underline-offset-4"
                      >
                        Email source <ExternalLink size={9} />
                      </a>
                    )}
                  </div>
                </>
              ) : (
                <div className="text-[12px] text-muted">
                  No source-confirmed contact email. This lead is not counted.
                </div>
              )}
            </div>

            <div className="mt-4">
              <dl>
                <DataRow label="Evidence">
                  {prospect.evidenceSummary || (
                    <span className="text-faint">Unknown</span>
                  )}
                </DataRow>
                <DataRow label="Country">
                  {prospect.country ? (
                    <span className="inline-flex items-center gap-1">
                      <MapPin size={11} className="text-faint" /> {prospect.country}
                    </span>
                  ) : (
                    <span className="text-faint">Unknown</span>
                  )}
                </DataRow>
                <DataRow label="Aliases">
                  {prospect.aliases.length ? (
                    prospect.aliases.join(" · ")
                  ) : (
                    <span className="text-faint">None recorded</span>
                  )}
                </DataRow>
                <DataRow label="Provenance">
                  <span className="inline-flex items-center gap-1">
                    <History size={10} className="text-faint" /> Added{" "}
                    {relativeTime(prospect.createdAt)} · qualification{" "}
                    {prospect.qualificationStatus}
                  </span>
                </DataRow>
              </dl>
            </div>

            <div className="mt-5 border-t border-line pt-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-[9.5px] font-bold uppercase tracking-[0.13em] text-faint">
                  Sources on file
                </div>
                <AddSourceButton prospectId={prospect.id} />
              </div>
              <div className="space-y-2">
                {prospect.sources.length === 0 ? (
                  <p className="text-[11px] text-faint">No sources recorded.</p>
                ) : (
                  prospect.sources.map((source) => (
                    <a
                      key={source.id}
                      href={source.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="group flex min-w-0 items-start justify-between gap-3 rounded-lg border border-line bg-white/50 px-3 py-2.5 transition hover:border-line-strong hover:bg-white"
                    >
                      <div className="min-w-0">
                        <div className="text-[11.5px] font-semibold text-ink group-hover:underline group-hover:underline-offset-4">
                          {source.label}
                        </div>
                        <div className="wrap-anywhere mt-0.5 text-[9.5px] text-faint" title={source.url}>
                          {source.url}
                        </div>
                        {source.notes && (
                          <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-muted">
                            {source.notes}
                          </p>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <ExternalLink
                          size={11}
                          className="text-faint group-hover:text-ink"
                        />
                        <div className="mt-1 text-[8.5px] text-faint">
                          {formatDate(source.observedAt)}
                        </div>
                      </div>
                    </a>
                  ))
                )}
              </div>
            </div>
          </Card>

          <Card className="p-5">
            <SectionHeading
              title="Commercial signal service"
              description="What is actually sold, observed from public evidence."
            />
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <div className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-faint">
                  Service
                </div>
                <p className="mt-1 text-[12.5px] leading-6 text-ink">
                  {prospect.signalDescription || (
                    <span className="text-faint">Unknown</span>
                  )}
                </p>
              </div>
              <div className="sm:col-span-2">
                <div className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-faint">
                  Published pricing / subscription
                </div>
                <p className="mt-1 text-[11.5px] leading-5 text-muted">
                  {prospect.pricingDetails || (
                    <span className="text-faint">Unknown</span>
                  )}
                </p>
              </div>
              <div>
                <div className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-faint">
                  Followers
                </div>
                <div className="mt-1 text-[11.5px] text-ink">
                  {prospect.followerCount || "Unknown"}
                </div>
              </div>
              <div>
                <div className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-faint">
                  Subscribers
                </div>
                <div className="mt-1 text-[11.5px] text-ink">
                  {prospect.subscriberCount || "Unknown"}
                </div>
              </div>
            </div>
            {socialLinks.length > 0 && (
              <div className="mt-5 flex flex-wrap gap-1.5 border-t border-line pt-4">
                {socialLinks.map((social) => (
                  <a
                    key={`${social.label}-${social.url}`}
                    href={social.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="badge transition hover:border-ink/25 hover:text-ink"
                  >
                    <social.icon size={10} />
                    {social.label}
                  </a>
                ))}
              </div>
            )}
            <div className="mt-4 rounded-xl border border-line bg-paper/50 p-3">
              <div className="text-[9px] font-bold uppercase tracking-[0.12em] text-faint">
                Research notes
              </div>
              <p className="mt-1 whitespace-pre-wrap text-[11px] leading-5 text-muted">
                {prospect.researchNotes || "No research notes recorded."}
              </p>
            </div>
          </Card>

          <Card className="p-5">
            <SectionHeading
              title="Conversation history"
              description="Sent, received and externally synchronized messages with this prospect."
              action={
                conversation ? (
                  <Link href={`/email/${conversation.id}`} className="btn-ghost btn-sm">
                    Full thread <ArrowRight size={11} />
                  </Link>
                ) : undefined
              }
            />
            {!conversation ? (
              <div className="mt-4 flex items-start gap-3 rounded-xl border border-dashed-line border-line px-4 py-5">
                <CircleDashed size={16} className="mt-0.5 text-faint" />
                <div>
                  <div className="text-[11.5px] font-semibold text-ink">
                    No conversation yet
                  </div>
                  <p className="mt-0.5 text-[10.5px] leading-5 text-muted">
                    When the first draft is sent, its thread appears here. Replies
                    are associated automatically by email and message headers.
                  </p>
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-2">
                {conversation.messages.slice(-5).map((message) => (
                  <div
                    key={message.id}
                    className={`rounded-xl border px-3 py-2.5 ${
                      message.direction === "inbound"
                        ? "border-amber/15 bg-amber/[0.035]"
                        : "border-line bg-white/50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] text-faint">
                        {message.direction === "inbound" ? (
                          <Mail size={9} />
                        ) : (
                          <CheckCircle2 size={9} />
                        )}
                        {message.direction === "inbound" ? "Received" : "Sent"}
                        {message.isSandbox && " · sandbox"}
                      </div>
                      <span className="text-[9px] text-faint">
                        {relativeTime(message.receivedAt || message.sentAt)}
                      </span>
                    </div>
                    <div className="mt-1 text-[11px] font-semibold text-ink">
                      {message.subject}
                    </div>
                    <p className="mt-1 line-clamp-2 text-[10.5px] leading-4 text-muted">
                      {message.bodyText}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <DraftEditor
            prospectId={prospect.id}
            businessName={prospect.businessName}
            initialDraft={draft}
            verifiedEmails={prospect.emails.map((email) => email.email)}
            sandboxMode={sandboxMode}
            canSend={blockedReasons.length === 0}
            sendBlockedReason={blockedReasons[0] || null}
            liveMode={!sandboxMode}
          />

          <PipelineCard prospect={prospect} />

          {followUps.length > 0 && (
            <Card className="p-5">
              <SectionHeading
                title="Follow-ups"
                description="Prepared only while the thread remains unanswered."
              />
              <div className="mt-3 space-y-2">
                {followUps.map((followUp) => (
                  <div
                    key={followUp.id}
                    className="flex items-center justify-between rounded-lg border border-line bg-white/50 px-3 py-2"
                  >
                    <div>
                      <div className="text-[11px] font-semibold text-ink">
                        Follow-up #{followUp.sequence}
                      </div>
                      <div className="mt-0.5 text-[9.5px] text-faint">
                        {followUp.subject}
                      </div>
                    </div>
                    <span className="badge capitalize">{followUp.status}</span>
                  </div>
                ))}
              </div>
              <Link href="/email?tab=followups" className="btn-ghost btn-xs mt-3 -ml-2">
                Review follow-ups <ArrowRight size={11} />
              </Link>
            </Card>
          )}

          <Card className="p-5">
            <SectionHeading title="Verification record" />
            <div className="mt-3 space-y-2.5">
              <div className="flex items-start gap-2.5">
                <CalendarDays size={13} className="mt-0.5 text-faint" />
                <div className="text-[10.5px] leading-5 text-muted">
                  <span className="font-semibold text-ink">Observed</span>
                  <br />
                  {prospect.verifiedAt
                    ? formatDateTime(prospect.verifiedAt)
                    : "Not verified"}
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <BadgeCheck size={13} className="mt-0.5 text-faint" />
                <div className="text-[10.5px] leading-5 text-muted">
                  <span className="font-semibold text-ink">Method</span>
                  <br />
                  Public website, pricing and contact-source review. No guessed
                  addresses.
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <Clock3 size={13} className="mt-0.5 text-faint" />
                <div className="text-[10.5px] leading-5 text-muted">
                  <span className="font-semibold text-ink">Last updated</span>
                  <br />
                  {formatDateTime(prospect.updatedAt)}
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
