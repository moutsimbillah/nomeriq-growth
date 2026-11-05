import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Clock3,
  Globe2,
  MessageSquare,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  getConversation,
  messageBodyForDisplay,
} from "@/lib/services/conversations";
import { getDefaultEmailAccount } from "@/lib/email/accounts";
import { getWorkspaceSettings } from "@/lib/services/settings";
import {
  Card,
  ExternalLink,
  PageHeader,
  SectionHeading,
} from "@/components/ui";
import {
  ClassificationSelect,
  MarkConversationRead,
  ReplyComposer,
  SimulateReplyButton,
} from "@/components/conversation-actions";
import { ConversationMessage } from "@/components/conversation-message";
import { translationOffered } from "@/lib/ai/language-detect";
import { formatDateTime, relativeTime } from "@/lib/utils";
import { CLASSIFICATION_LABELS } from "@/lib/types";

export const dynamic = "force-dynamic";

const NEXT_ACTION: Record<string, string> = {
  interested: "Offer a short demo and ask about their current signal workflow.",
  demo: "Send two specific time options and confirm who should join.",
  features: "Answer the real feature question from approved Product Truth; flag unknowns.",
  pricing: "Confirm founder-approved commercial terms before quoting anything.",
  technical: "Clarify their stack first; do not invent integrations.",
  not_interested: "Close politely. Suppression has already stopped follow-ups.",
  unsubscribe: "No further contact. The suppression is recorded.",
  other: "Read the actual message and ask for the missing detail.",
};

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const conversation = await getConversation(id);
  if (!conversation) notFound();
  const settings = await getWorkspaceSettings();
  const account = await getDefaultEmailAccount().catch(() => null);
  const envSandbox =
    (process.env.EMAIL_DELIVERY_MODE || "sandbox").toLowerCase() !== "live";
  const sandbox = envSandbox || account?.provider === "sandbox";
  const hasInbound = conversation.messages.some(
    (message) => message.direction === "inbound",
  );
  const lastInbound = conversation.messages.find(
    (message) => message.direction === "inbound",
  );
  const defaultSubject = lastInbound?.subject?.toLowerCase().startsWith("re:")
    ? lastInbound.subject
    : `Re: ${lastInbound?.subject || conversation.subject}`;

  return (
    <div className="animate-fade-up">
      <MarkConversationRead conversationId={conversation.id} />
      <div className="mb-5 flex items-center gap-2 text-12 text-faint">
        <Link href="/email" className="inline-flex items-center gap-1 hover:text-ink">
          <ArrowLeft size={11} /> Email
        </Link>
        <span>/</span>
        <Link
          href={`/leads/${conversation.prospect.id}`}
          className="hover:text-ink"
        >
          {conversation.prospect.businessName}
        </Link>
        <span>/</span>
        <span className="text-muted">Conversation</span>
      </div>

      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            {CLASSIFICATION_LABELS[conversation.classification]}
            <span className="text-faint">·</span>
            {relativeTime(conversation.lastInboundAt)} reply
            {conversation.classificationSource === "founder" && " · founder corrected"}
          </span>
        }
        title={conversation.subject}
        description={`${conversation.prospect.businessName} · ${conversation.prospect.contactEmail || "contact email unknown"} · ${conversation.messages.length} messages`}
        actions={
          <>
            <Link
              href={`/leads/${conversation.prospect.id}`}
              className="btn-secondary"
            >
              <Building2 size={13} /> Lead record
            </Link>
            <Link href="/email" className="btn-ghost">
              <ArrowLeft size={13} /> Inbox
            </Link>
          </>
        }
      />

      {sandbox && (
        <div className="mb-4 rounded-xl border border-amber/20 bg-amber/[0.05] px-3.5 py-2 text-12 text-[#76501a]">
          Sandbox thread. Test messages are clearly flagged and no email leaves
          Growth. Use “Simulate a test reply” to exercise the full loop safely.
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <div className="space-y-3">
          {conversation.messages.map((message, index) => {
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
                timeLabel={formatDateTime(
                  message.receivedAt || message.sentAt,
                  settings.timezone,
                )}
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
          })}
        </div>

        <div className="space-y-4">
          {hasInbound ? (
            <ReplyComposer
              conversationId={conversation.id}
              defaultSubject={defaultSubject}
              recipient={conversation.replyTo}
              suppressed={conversation.suppressed}
              blockedReason={conversation.blockedReason}
              sandbox={sandbox}
            />
          ) : (
            <Card className="p-5">
              <div className="flex items-start gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-full bg-forest/[0.06] text-forest">
                  <Clock3 size={15} />
                </div>
                <div>
                  <h2 className="text-13 font-bold text-ink">Waiting for a reply</h2>
                  <p className="mt-1 text-12 leading-5 text-muted">
                    This thread has outbound messages but no inbound reply yet.
                    Follow-ups stay reviewable and are never sent automatically.
                  </p>
                </div>
              </div>
              {sandbox && (
                <div className="mt-4">
                  <SimulateReplyButton
                    conversationId={conversation.id}
                    companyName={conversation.prospect.businessName}
                  />
                </div>
              )}
            </Card>
          )}

          <Card className="p-5">
            <SectionHeading
              title="Conversation controls"
              description="AI suggests. The founder decides. The server enforces the safeguards."
            />
            <div className="mt-4">
              <ClassificationSelect
                conversationId={conversation.id}
                value={conversation.classification}
              />
            </div>
            <div className="mt-4 rounded-xl border border-line bg-paper/50 p-3">
              <div className="flex items-center gap-2 text-12 font-bold uppercase tracking-[0.12em] text-faint">
                <Sparkles size={10} /> Suggested next action
              </div>
              <p className="mt-1 text-12 leading-5 text-muted">
                {NEXT_ACTION[conversation.classification] ||
                  "Read the message and respond to the actual question."}
              </p>
            </div>
            {conversation.suppressed && (
              <div className="mt-3 rounded-lg border border-rust/20 bg-rust/[0.05] px-2.5 py-2 text-12 leading-4 text-rust">
                Suppression is active. No promotional email can be sent to this
                contact, including replies.
              </div>
            )}
            {sandbox && hasInbound && (
              <div className="mt-3">
                <SimulateReplyButton
                  conversationId={conversation.id}
                  companyName={conversation.prospect.businessName}
                />
              </div>
            )}
          </Card>

          <Card className="p-5">
            <SectionHeading title="Prospect context" />
            <div className="mt-3 space-y-2.5">
              <div className="flex items-start gap-2.5">
                <Globe2 size={13} className="mt-0.5 text-faint" />
                <div className="min-w-0 text-12 leading-5 text-muted">
                  <span className="font-semibold text-ink">Website</span>
                  <br />
                  {conversation.prospect.websiteUrl ? (
                    <ExternalLink
                      href={conversation.prospect.websiteUrl}
                      className="text-12"
                    >
                      {conversation.prospect.domainKey}
                    </ExternalLink>
                  ) : (
                    "Unknown"
                  )}
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <MessageSquare size={13} className="mt-0.5 text-faint" />
                <div className="text-12 leading-5 text-muted">
                  <span className="font-semibold text-ink">Signal service</span>
                  <br />
                  {conversation.prospect.signalDescription || "Unknown"}
                </div>
              </div>
              <div className="flex items-start gap-2.5">
                <ShieldCheck size={13} className="mt-0.5 text-faint" />
                <div className="text-12 leading-5 text-muted">
                  <span className="font-semibold text-ink">Thread integrity</span>
                  <br />
                  Reply threads are preserved with In-Reply-To and References.
                  External IONOS sends are synchronized into the same thread.
                </div>
              </div>
            </div>
            <Link
              href={`/leads/${conversation.prospect.id}`}
              className="btn-secondary btn-sm mt-4 w-full"
            >
              Open full lead <ArrowRight size={12} />
            </Link>
          </Card>
        </div>
      </div>
    </div>
  );
}
