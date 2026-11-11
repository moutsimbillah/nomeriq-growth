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
import { draftProvenance } from "@/lib/ai/provenance";
import { getConversationForProspect, previewMessages } from "@/lib/services/conversations";
import { SendingProfileControl } from "@/components/sending-profile-control";
import { FollowUpExclusionControl } from "@/components/follow-up-exclusion-control";
import { LeadReplyRecipient } from "@/components/lead-reply-recipient";
import { getAddressDeliveryStatuses } from "@/lib/email/bounce-handling";
import {
  getDefaultEmailAccount,
  getEmailAccountRecord,
  listEmailAccounts,
} from "@/lib/email/accounts";
import { getWorkspaceSettings } from "@/lib/services/settings";
import {
  AgentPill,
  SenderPill,
  Card,
  CategoryPill,
  DataRow,
  Notice,
  PageHeader,
  SectionHeading,
} from "@/components/ui";
import { NO_SENDER_LABEL, senderLabels, senderShortName } from "@/lib/email/senderPill";
import {
  AddSourceButton,
  ArchiveLeadButton,
  DraftEditor,
  PipelineCard,
} from "@/components/lead-actions";
import { formatDate, formatDateTime, relativeTime } from "@/lib/utils";
import { LeadQualificationPills, AudiencePills, PriorityLabel, ProductFitPanel, ContactRoutes } from "@/components/lead-qualification";
import { getLeadModel } from "@/lib/services/lead-model";
import { latestOfferRejection } from "@/lib/services/lead-rejections";
import { getLeadOutreachBlock } from "@/lib/services/lead-outreach-guard";
import { getSessionUser } from "@/lib/auth/session";
import {
  getActiveDuplicateLink,
  listDuplicatesOf,
  type DuplicateLinkView,
} from "@/lib/services/prospect-duplicates";
import {
  DuplicatesOfList,
  MarkDuplicateButton,
  RestoreDuplicateButton,
} from "@/components/prospect-duplicate-control";

export const dynamic = "force-dynamic";

/**
 * An archived lead normally has no page. A lead the founder marked "Duplicate of" keeps a small one,
 * so the link from the lead it duplicates works and the founder can restore it.
 */
function DuplicateLeadView({
  link,
  canManage,
  timezone,
}: {
  link: DuplicateLinkView;
  canManage: boolean;
  timezone: string;
}) {
  return (
    <div className="animate-fade-up">
      <div className="mb-5 flex items-center gap-2 text-12 text-faint">
        <Link href="/leads" className="inline-flex items-center gap-1 hover:text-ink">
          <ArrowLeft size={11} /> All leads
        </Link>
        <span>/</span>
        <span className="text-muted">{link.prospectName}</span>
      </div>
      <PageHeader
        eyebrow="Archived · marked as a duplicate"
        title={link.prospectName}
        actions={canManage ? <RestoreDuplicateButton prospectId={link.prospectId} /> : undefined}
      />
      <div data-duplicate-of={link.canonicalProspectId}>
      <Card className="p-5">
        <SectionHeading
          title="Duplicate of"
          description="This lead is archived and marked do-not-contact. Work continues on the lead below."
        />
        <p className="mt-3 text-14">
          {link.canonicalActive ? (
            <Link
              href={`/leads/${link.canonicalProspectId}`}
              className="inline-flex items-center gap-1 font-semibold text-ink underline underline-offset-4"
            >
              {link.canonicalName} <ArrowRight size={12} />
            </Link>
          ) : (
            <span className="font-semibold text-ink">{link.canonicalName} (now archived)</span>
          )}
        </p>
        <p className="mt-3 text-12 text-muted">
          Marked {formatDateTime(link.createdAt, timezone)} · {link.cancelledDrafts} unsent draft
          {link.cancelledDrafts === 1 ? "" : "s"} cancelled · {link.blockedSends} queued email
          {link.blockedSends === 1 ? "" : "s"} stopped. No address was suppressed.
        </p>
      </Card>
      </div>
    </div>
  );
}

export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const { saved } = await searchParams;
  const prospect = await getProspect(id);
  if (!prospect) {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const link = UUID.test(id) ? await getActiveDuplicateLink(id) : null;
    if (!link) notFound();
    const [viewer, workspace] = await Promise.all([getSessionUser(), getWorkspaceSettings()]);
    return (
      <DuplicateLeadView
        link={link}
        canManage={viewer?.role === "founder"}
        timezone={workspace.timezone}
      />
    );
  }

  const [draft, conversation, drafts, account, settings, addressStatuses, model, rejection, viewer, duplicatesOf] = await Promise.all([
    getFirstContactDraft(id),
    getConversationForProspect(id),
    listDraftsForProspect(id),
    getDefaultEmailAccount().catch(() => null),
    getWorkspaceSettings(),
    getAddressDeliveryStatuses(prospect.id),
    getLeadModel(id),
    latestOfferRejection(id),
    getSessionUser(),
    listDuplicatesOf(prospect.id),
  ]);
  const isFounder = viewer?.role === "founder";
  const profileAccounts = await listEmailAccounts();
  const profileLabelById = senderLabels(profileAccounts);
  const profileOptions = profileAccounts.map((row) => ({
    id: row.id,
    label: profileLabelById.get(row.id) ?? senderShortName(row),
  }));

  // The mailbox this lead's email comes from: its own pinned profile, else the workspace default — and
  // nothing else. There is deliberately no "the only account" fallback, so a lead the import never pinned
  // is not shown as nomeriq.com (and cannot be sent from it either).
  const pinnedProfile = prospect.sendingProfileId
    ? await getEmailAccountRecord(prospect.sendingProfileId).catch(() => null)
    : null;
  const sendingProfile = pinnedProfile ?? account;
  const labelOf = (profile: { id: string; name: string; emailAddress: string }) =>
    profileLabelById.get(profile.id) ?? senderShortName(profile);
  const pinnedLabel = pinnedProfile ? labelOf(pinnedProfile) : NO_SENDER_LABEL;
  const envSandbox = (process.env.EMAIL_DELIVERY_MODE || "sandbox").toLowerCase() !== "live";
  const sandboxMode = envSandbox || sendingProfile?.provider === "sandbox";
  const followUps = drafts.filter((item) => item.kind === "follow_up");
  const blockedReasons: string[] = [];
  const tierBlock = await getLeadOutreachBlock(prospect.id);
  if (tierBlock) blockedReasons.push(tierBlock.reason);
  if (!sendingProfile)
    blockedReasons.push(
      "This lead has no sending profile yet. Pick the mailbox it is sent from on the lead page.",
    );
  else if (sendingProfile.status !== "connected")
    blockedReasons.push(
      sendingProfile.lastError ||
        "The mailbox that would send for this lead is not healthy.",
    );
  if (!sandboxMode && (!settings.postalAddressEnabled || !settings.postalAddress.trim()))
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
      {saved === "candidate" && (
        <div className="mb-4" data-saved-outcome="candidate">
          <Notice
            tone="info"
            title="Saved as a candidate."
          >
            No assessment was supplied, so this lead is not verified and does not count toward a
            research target yet. Sources and an evidence-backed assessment are still needed.
          </Notice>
        </div>
      )}
      <div className="mb-5 flex items-center gap-2 text-12 text-faint">
        <Link href="/leads" className="inline-flex items-center gap-1 hover:text-ink">
          <ArrowLeft size={11} /> All leads
        </Link>
        <span>/</span>
        <span className="text-muted">{prospect.businessName}</span>
      </div>

      <PageHeader
        eyebrow={`${prospect.country || "Country unknown"} · discovered ${formatDate(prospect.createdAt, undefined, settings.timezone)}`}
        title={prospect.businessName}
        titleAside={
          <span className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
            <LeadQualificationPills model={model} />
            <PriorityLabel model={model} />
            {prospect.qualificationStatus === "verified" && (
              <span className="inline-flex items-center gap-1 rounded-full border border-forest/15 bg-lime/35 px-2.5 py-1 text-12 font-bold uppercase tracking-[0.1em] text-forest">
                <BadgeCheck size={11} /> Verified business
              </span>
            )}
            <AgentPill
              agent={prospect.sourceAgent ?? "unknown"}
              channel={prospect.sourceChannel}
              note={prospect.sourceAgent === "other" ? prospect.sourceClient : undefined}
              size="lg"
            />
            <SenderPill
              profile={
                pinnedProfile
                  ? { id: pinnedProfile.id, label: pinnedLabel }
                  : { id: null, label: NO_SENDER_LABEL }
              }
              title={
                pinnedProfile
                  ? `${pinnedProfile.emailAddress} — ${pinnedProfile.name}`
                  : account
                    ? `No sending profile yet — ${account.emailAddress} (${account.name}) is the default and will send this lead's first email`
                    : "No sending profile yet — pick the mailbox this lead is sent from"
              }
              size="lg"
            />
            {prospect.sendingProfilePinnedAt ? (
              <span
                className="text-13 font-medium text-muted"
                title="This lead has already been emailed from its profile, so it stays there — its replies are in that thread."
              >
                Locked to {pinnedLabel} — already emailed from it
              </span>
            ) : !tierBlock ? (
              <SendingProfileControl
                prospectId={prospect.id}
                currentId={prospect.sendingProfileId ?? ""}
                profiles={profileOptions}
              />
            ) : null}
            {!tierBlock && !rejection ? <FollowUpExclusionControl
              prospectId={prospect.id}
              excluded={prospect.followUpExcluded}
            /> : <span className="text-13 font-medium text-muted">Automatic follow-ups stopped</span>}
            {prospect.sourceChannel ? (
              <span className="text-13 font-medium text-muted">
                via {CHANNEL_LABELS[prospect.sourceChannel]}
              </span>
            ) : null}
            <DuplicatesOfList duplicates={duplicatesOf} />
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
                className="inline-flex items-center gap-1 text-12 font-semibold text-muted hover:text-ink"
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
            {isFounder && (
              <MarkDuplicateButton prospectId={prospect.id} businessName={prospect.businessName} />
            )}
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[1.45fr_1fr] [&>*]:min-w-0">
        <div className="space-y-4">
          {rejection && <section className="rounded-2xl border border-amber-700/25 bg-amber-50 p-5" aria-label="Closed Lost recommendation">
            <h2 className="text-16 font-bold text-ink">Recommend Closed/Lost — awaiting your confirmation</h2>
            <p className="mt-2 text-13 text-muted">{rejection.reason}</p>
            <blockquote className="mt-3 whitespace-pre-wrap border-l-2 border-amber-700/30 pl-3 text-13 text-ink">{rejection.objection}</blockquote>
            <p className="mt-2 text-12 text-faint">Original reply preserved · {formatDateTime(rejection.recordedAt, settings.timezone)} · Confirm Lost using the stage controls; no automatic stage change.</p>
          </section>}
          <ProductFitPanel model={model} />
          {(model.tier === "category_b" || model.tier === "email_no_website" || model.contactRoutes.length > 0) && <ContactRoutes routes={model.contactRoutes} />}
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
                        <div className="wrap-anywhere text-14 font-semibold text-ink">
                          {prospect.contactEmail}
                        </div>
                        <div className="mt-0.5 text-12 uppercase tracking-[0.1em] text-faint">
                          Public business contact
                        </div>
                      </div>
                    </div>
                    {!tierBlock && <a
                      href={`mailto:${prospect.contactEmail}`}
                      className="btn-secondary btn-xs"
                    >
                      <Mail size={11} /> Compose externally
                    </a>}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-12 text-muted">
                    <span className="inline-flex items-center gap-1">
                      <ShieldCheck size={10} className="text-forest" />
                      Verified {prospect.verifiedAt ? formatDate(prospect.verifiedAt, undefined, settings.timezone) : "date unknown"}
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
                <div className="text-12 text-muted">
                  No source-confirmed contact email. This lead is not counted.
                </div>
              )}
            </div>

            <div className="mt-4">
              <AudiencePills accounts={model.audiences} />
              <dl>
                <DataRow label="Address delivery status">
                  <ul className="min-w-0 space-y-2 break-anywhere">
                    {addressStatuses.map((address) => <li key={address.normalizedEmail}>
                      <span className="font-semibold text-ink">{address.email}</span>{" — "}
                      {address.status === "permanent_bounced" ? "bounced, permanent" :
                        address.status === "transient_suppressed" ? "temporary, suppressed (retry limit reached)" :
                        address.status === "transient_retrying" ? "temporary, retrying" :
                        address.status === "complaint" ? "complaint, suppressed" : "No delivery failure recorded"}
                      {address.occurredAt && `, on ${formatDate(address.occurredAt, undefined, settings.timezone)}`}
                      {address.suppressed && " · Suppressed; sending blocked"}
                    </li>)}
                    {addressStatuses.length === 0 && <li>No stored addresses.</li>}
                  </ul>
                </DataRow>
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
                <div className="text-12 font-bold uppercase tracking-[0.13em] text-faint">
                  Sources on file
                </div>
                <AddSourceButton prospectId={prospect.id} />
              </div>
              <div className="space-y-2">
                {prospect.sources.length === 0 ? (
                  <p className="text-12 text-faint">No sources recorded.</p>
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
                        <div className="text-12 font-semibold text-ink group-hover:underline group-hover:underline-offset-4">
                          {source.label}
                        </div>
                        <div className="wrap-anywhere mt-0.5 text-12 text-faint" title={source.url}>
                          {source.url}
                        </div>
                        {source.notes && (
                          <p className="mt-1 line-clamp-2 text-12 leading-4 text-muted">
                            {source.notes}
                          </p>
                        )}
                      </div>
                      <div className="shrink-0 text-right">
                        <ExternalLink
                          size={11}
                          className="text-faint group-hover:text-ink"
                        />
                        <div className="mt-1 text-12 text-faint">
                          {formatDate(source.observedAt, undefined, settings.timezone)}
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
                <div className="text-12 font-bold uppercase tracking-[0.12em] text-faint">
                  Service
                </div>
                <p className="mt-1 text-13 leading-6 text-ink">
                  {prospect.signalDescription || (
                    <span className="text-faint">Unknown</span>
                  )}
                </p>
              </div>
              <div className="sm:col-span-2">
                <div className="text-12 font-bold uppercase tracking-[0.12em] text-faint">
                  Published pricing / subscription
                </div>
                <p className="mt-1 text-12 leading-5 text-muted">
                  {prospect.pricingDetails || (
                    <span className="text-faint">Unknown</span>
                  )}
                </p>
              </div>
              <div>
                <div className="text-12 font-bold uppercase tracking-[0.12em] text-faint">
                  Followers
                </div>
                <div className="mt-1 text-12 text-ink">
                  {prospect.followerCount || "Unknown"}
                </div>
              </div>
              <div>
                <div className="text-12 font-bold uppercase tracking-[0.12em] text-faint">
                  Subscribers
                </div>
                <div className="mt-1 text-12 text-ink">
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
              <div className="text-12 font-bold uppercase tracking-[0.12em] text-faint">
                Research notes
              </div>
              <p className="mt-1 whitespace-pre-wrap text-12 leading-5 text-muted">
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
                  <div className="text-12 font-semibold text-ink">
                    No conversation yet
                  </div>
                  <p className="mt-0.5 text-12 leading-5 text-muted">
                    When the first draft is sent, its thread appears here. Replies
                    are associated automatically by email and message headers.
                  </p>
                </div>
              </div>
            ) : (
              <div className="mt-4 space-y-2">
                {previewMessages(conversation.messages).map((message) => (
                  <div
                    key={message.id}
                    className={`rounded-xl border px-3 py-2.5 ${
                      message.direction === "inbound"
                        ? "border-amber/15 bg-amber/[0.035]"
                        : "border-line bg-white/50"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-12 font-semibold uppercase tracking-[0.08em] text-faint">
                        {message.direction === "inbound" ? (
                          <Mail size={9} />
                        ) : (
                          <CheckCircle2 size={9} />
                        )}
                        {message.direction === "inbound" ? "Received" : "Sent"}
                        {message.isSandbox && " · sandbox"}
                      </div>
                      <span className="text-12 text-faint">
                        {relativeTime(message.receivedAt || message.sentAt)}
                      </span>
                    </div>
                    <div className="mt-1 text-12 font-semibold text-ink">
                      {message.subject}
                    </div>
                    <p className="mt-1 line-clamp-2 text-12 leading-4 text-muted">
                      {message.bodyText}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          {!tierBlock && <LeadReplyRecipient prospectId={prospect.id} />}
          {tierBlock ? <Card className="p-5">
            <SectionHeading title="Email outreach blocked" description={tierBlock.reason} />
            {draft && <details className="mt-3 text-12 text-muted"><summary>Retained historical draft — read only</summary><p className="mt-2 font-semibold">{draft.subject}</p><p className="mt-2 whitespace-pre-wrap">{draft.body}</p></details>}
          </Card> : <DraftEditor
            prospectId={prospect.id}
            businessName={prospect.businessName}
            initialDraft={draft}
            verifiedEmails={prospect.emails.map((email) => email.email)}
            sandboxMode={sandboxMode}
            canSend={blockedReasons.length === 0}
            sendBlockedReason={blockedReasons[0] || null}
            liveMode={!sandboxMode}
          />}

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
                      <div className="text-12 font-semibold text-ink">
                        Follow-up #{followUp.sequence}
                      </div>
                      <div className="mt-0.5 text-12 text-faint">
                        {followUp.subject}
                      </div>
                      <div className="mt-0.5 text-12 text-faint" data-draft-provenance>
                        {draftProvenance(followUp)}
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
                <div className="text-12 leading-5 text-muted">
                  <span className="font-semibold text-ink">Observed</span>
                  <br />
                  {prospect.verifiedAt
                    ? formatDateTime(prospect.verifiedAt, settings.timezone)
                    : "Not verified"}
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <BadgeCheck size={13} className="mt-0.5 text-faint" />
                <div className="text-12 leading-5 text-muted">
                  <span className="font-semibold text-ink">Method</span>
                  <br />
                  Public website, pricing and contact-source review. No guessed
                  addresses.
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <Clock3 size={13} className="mt-0.5 text-faint" />
                <div className="text-12 leading-5 text-muted">
                  <span className="font-semibold text-ink">Last updated</span>
                  <br />
                  {formatDateTime(prospect.updatedAt, settings.timezone)}
                </div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
