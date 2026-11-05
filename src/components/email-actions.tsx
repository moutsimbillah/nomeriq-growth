"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Clock3,
  LoaderCircle,
  Pause,
  Play,
  Send,
  Sparkles,
  Square,
  WandSparkles,
} from "lucide-react";
import { apiRequest, InlineError, Modal, SubmitBar } from "./client-ui";
import { Notice } from "./ui";
import { useWorkspaceTimezone } from "./workspace-timezone";
import type { Draft } from "@/lib/types";

export function FollowUpReview({
  draft,
  sandbox,
}: {
  draft: Draft;
  sandbox: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const editable = ["draft", "approved"].includes(draft.status);

  async function save(): Promise<boolean> {
    if (!editable) return true;
    if (subject === draft.subject && body === draft.body) return true;
    await apiRequest(`/api/drafts/${draft.id}`, {
      method: "PATCH",
      body: {
        subject,
        body,
        recipientEmail: draft.recipientEmail,
      },
    });
    return true;
  }

  async function approve() {
    setPending("approve");
    setError(null);
    try {
      await save();
      await apiRequest(`/api/drafts/${draft.id}/approve`, { method: "POST" });
      setNotice("Approved. You can send it now.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not approve.");
    } finally {
      setPending(null);
    }
  }

  async function send() {
    setPending("send");
    setError(null);
    setNotice(null);
    try {
      await save();
      await apiRequest(`/api/drafts/${draft.id}/send`, {
        body: { approveFirst: true },
      });
      setNotice(
        sandbox
          ? "Recorded in the sandbox mailbox. Nothing was transmitted."
          : "Accepted by the sending server. Inbox delivery is not guaranteed.",
      );
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not send.");
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-secondary btn-xs"
        onClick={() => setOpen(true)}
      >
        {editable ? "Review" : "View"} <ArrowRight size={10} />
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Follow-up #${draft.sequence} — ${draft.prospectName}`}
        description="A follow-up is only sent after your review. Replies and opt-outs cancel this sequence automatically."
        width="lg"
      >
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="badge capitalize">{draft.status}</span>
            <span className="text-12 text-faint">
              To {draft.recipientEmail}
            </span>
          </div>
          <div>
            <label className="label">Subject</label>
            <input
              className="input"
              value={subject}
              onChange={(event) => setSubject(event.target.value)}
              disabled={!editable}
            />
          </div>
          <div>
            <label className="label">Message</label>
            <textarea
              className="textarea min-h-[300px] bg-[#fffefb]"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              disabled={!editable}
            />
          </div>
          {draft.warnings.length > 0 && (
            <div className="space-y-1">
              {draft.warnings.map((warning) => (
                <div
                  key={warning.code}
                  className="rounded-lg border border-amber/20 bg-amber/[0.05] px-2.5 py-1.5 text-12 leading-4 text-[#76501a]"
                >
                  {warning.message}
                </div>
              ))}
            </div>
          )}
          {error && <InlineError>{error}</InlineError>}
          {notice && (
            <div className="rounded-lg border border-forest/20 bg-lime/15 px-2.5 py-2 text-12 text-forest">
              {notice}
            </div>
          )}
          <SubmitBar>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Close
            </button>
            {editable && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={async () => {
                    setPending("save");
                    setError(null);
                    try {
                      await save();
                      setNotice("Saved.");
                      router.refresh();
                    } catch (caught) {
                      setError(caught instanceof Error ? caught.message : "Could not save.");
                    } finally {
                      setPending(null);
                    }
                  }}
                  disabled={!!pending}
                >
                  {pending === "save" ? <LoaderCircle size={12} className="spin" /> : null}
                  Save
                </button>
                {draft.status !== "approved" && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={approve}
                    disabled={!!pending}
                  >
                    Approve
                  </button>
                )}
                <button
                  type="button"
                  className="btn-primary"
                  onClick={send}
                  disabled={!!pending}
                >
                  {pending === "send" ? (
                    <LoaderCircle size={12} className="spin" />
                  ) : (
                    <Send size={12} />
                  )}
                  {sandbox ? "Record sandbox send" : "Approve & send"}
                </button>
              </>
            )}
          </SubmitBar>
        </div>
      </Modal>
    </>
  );
}

export function PrepareFollowUpsButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function prepare() {
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const result = await apiRequest("/api/followups/prepare", { body: {} });
      setMessage(
        result.prepared
          ? `${result.prepared} follow-up draft${result.prepared === 1 ? "" : "s"} prepared for review. Nothing was sent.`
          : "No follow-ups are due right now.",
      );
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not prepare.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        className="btn-secondary btn-sm"
        onClick={prepare}
        disabled={pending}
      >
        {pending ? <LoaderCircle size={12} className="spin" /> : <Sparkles size={12} />}
        {pending ? "Preparing…" : "Prepare due follow-ups"}
      </button>
      {message && <span className="max-w-[300px] text-right text-12 text-muted">{message}</span>}
      {error && <span className="max-w-[300px] text-right text-12 text-rust">{error}</span>}
    </div>
  );
}

interface ApprovedDraft {
  id: string;
  prospectName: string;
  subject: string;
}

interface AccountOption {
  id: string;
  emailAddress: string;
  provider: string;
  status: string;
}

export function NewCampaignButton({
  drafts,
  accounts,
}: {
  drafts: ApprovedDraft[];
  accounts: AccountOption[];
}) {
  const router = useRouter();
  const timezone = useWorkspaceTimezone();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(
    `First contact — ${new Date().toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: timezone,
    })}`,
  );
  const [selected, setSelected] = useState<string[]>(drafts.map((draft) => draft.id));
  const [accountId, setAccountId] = useState(
    accounts.find((account) => account.status === "connected")?.id || "",
  );
  const [authorized, setAuthorized] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setPending(true);
    setError(null);
    try {
      await apiRequest("/api/campaigns", {
        body: {
          name,
          accountId,
          draftIds: selected,
          authorize: authorized,
        },
      });
      setOpen(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create campaign.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-primary btn-sm"
        onClick={() => setOpen(true)}
        disabled={drafts.length === 0}
      >
        <Send size={12} />
        New campaign
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create a founder-authorized campaign"
        description="Only approved first-contact drafts can be queued. The campaign will not send until you start it, and it only runs while this tab is open."
        width="lg"
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
            <div>
              <label className="label">Campaign name</label>
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div>
              <label className="label">Sending account</label>
              <select
                className="select"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.emailAddress}
                    {account.provider === "sandbox" ? " (sandbox)" : ""}
                    {account.status !== "connected" ? " — not connected" : ""}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="label mb-0">Approved drafts</span>
              <button
                type="button"
                className="text-12 font-semibold text-muted underline underline-offset-4"
                onClick={() =>
                  setSelected(
                    selected.length === drafts.length
                      ? []
                      : drafts.map((draft) => draft.id),
                  )
                }
              >
                {selected.length === drafts.length ? "Clear all" : "Select all"}
              </button>
            </div>
            <div className="max-h-[280px] space-y-1.5 overflow-y-auto rounded-xl border border-line bg-paper/40 p-2 scrollbar-thin">
              {drafts.map((draft) => {
                const active = selected.includes(draft.id);
                return (
                  <button
                    type="button"
                    key={draft.id}
                    onClick={() =>
                      setSelected((current) =>
                        active
                          ? current.filter((id) => id !== draft.id)
                          : [...current, draft.id],
                      )
                    }
                    className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition ${
                      active
                        ? "border-forest/20 bg-white"
                        : "border-transparent hover:bg-white/60"
                    }`}
                  >
                    <span
                      className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-[5px] border ${
                        active ? "border-forest bg-forest text-lime" : "border-line-strong"
                      }`}
                    >
                      {active && <span className="h-1.5 w-1.5 rounded-[2px] bg-lime" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-12 font-semibold text-ink">
                        {draft.prospectName}
                      </span>
                      <span className="mt-0.5 block truncate text-12 text-faint">
                        {draft.subject}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-amber/20 bg-amber/[0.04] p-3 text-12 leading-5 text-[#76501a]">
            <input
              type="checkbox"
              checked={authorized}
              onChange={(event) => setAuthorized(event.target.checked)}
              className="mt-0.5 accent-[#11231a]"
            />
            <span>
              I authorize this specific batch. I understand the campaign only
              runs while the tab is open, respects the configured interval and
              daily limit, and stops at suppression, replies or a provider error.
            </span>
          </label>
          <Notice tone="info">
            Growth never invents provider limits. The visible interval and daily
            cap are the account's configured safety limits, not claims about
            IONOS's actual ceilings.
          </Notice>
          <InlineError>{error}</InlineError>
          <SubmitBar>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={create}
              disabled={
                pending ||
                !authorized ||
                !accountId ||
                selected.length === 0 ||
                !name.trim()
              }
            >
              {pending ? <LoaderCircle size={13} className="spin" /> : <Send size={13} />}
              {pending ? "Creating…" : "Create authorized campaign"}
            </button>
          </SubmitBar>
        </div>
      </Modal>
    </>
  );
}

export function CampaignActions({
  campaign,
}: {
  campaign: {
    id: string;
    status: string;
    total: number;
    sent: number;
    failed: number;
    queued: number;
  };
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const stopRef = useRef(false);

  async function changeStatus(status: "paused" | "active" | "cancelled") {
    setPending(status);
    setError(null);
    try {
      await apiRequest(`/api/campaigns/${campaign.id}/status`, {
        body: { status },
      });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update.");
    } finally {
      setPending(null);
    }
  }

  async function start() {
    setPending("start");
    setError(null);
    try {
      await apiRequest(`/api/campaigns/${campaign.id}/start`, { method: "POST" });
      await run();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start.");
      setPending(null);
    }
  }

  async function retry() {
    setPending("retry");
    setError(null);
    try {
      const result = await apiRequest(`/api/campaigns/${campaign.id}/retry`, {
        method: "POST",
      });
      if (!result.queued) {
        setError(
          result.uncertain
            ? `${result.uncertain} failed item(s) have uncertain delivery. Check the Sent folder before retrying.`
            : "No retryable failed items.",
        );
        setPending(null);
        return;
      }
      setPending(null);
      await run();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not retry.");
      setPending(null);
    }
  }

  async function run() {
    setRunning(true);
    stopRef.current = false;
    setError(null);
    setPending(null);
    let guard = 0;
    try {
      while (!stopRef.current && guard < 500) {
        guard += 1;
        const result = await apiRequest(
          `/api/campaigns/${campaign.id}/send-next`,
          { method: "POST" },
        );
        if (result.progress) {
          setStatusLine(
            `${result.progress.sent} sent · ${result.progress.queued} left · ${result.progress.failed} failed`,
          );
        }
        if (result.done) {
          setStatusLine("Campaign complete.");
          break;
        }
        if (result.error && !result.sent) {
          if (result.error.includes("workspace day")) {
            setError(result.error);
            break;
          }
          if (!result.nextAllowedAt) {
            setError(result.error);
            break;
          }
        }
        if (result.nextAllowedAt) {
          const wait = Math.max(
            800,
            new Date(result.nextAllowedAt).getTime() - Date.now() + 300,
          );
          setStatusLine(
            `Waiting ${Math.ceil(wait / 1000)}s for the configured send interval…`,
          );
          await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 65_000)));
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Campaign run failed.");
    } finally {
      setRunning(false);
      router.refresh();
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        {campaign.status === "approved" && (
          <button
            type="button"
            className="btn-primary btn-xs"
            onClick={start}
            disabled={!!pending || running}
          >
            {pending === "start" ? (
              <LoaderCircle size={10} className="spin" />
            ) : (
              <Play size={10} />
            )}
            Start & run
          </button>
        )}
        {campaign.failed > 0 && !running && (
          <button
            type="button"
            className="btn-secondary btn-xs"
            onClick={retry}
            disabled={!!pending}
          >
            {pending === "retry" ? (
              <LoaderCircle size={10} className="spin" />
            ) : (
              <Send size={10} />
            )}
            Retry failed
          </button>
        )}
        {campaign.status === "active" && !running && (
          <button type="button" className="btn-primary btn-xs" onClick={run}>
            <Play size={10} /> Run in this tab
          </button>
        )}
        {campaign.status === "active" && (
          <button
            type="button"
            className="btn-secondary btn-xs"
            onClick={() => changeStatus("paused")}
            disabled={!!pending}
          >
            <Pause size={10} /> Pause
          </button>
        )}
        {campaign.status === "paused" && (
          <button
            type="button"
            className="btn-primary btn-xs"
            onClick={async () => {
              await changeStatus("active");
              await run();
            }}
            disabled={!!pending || running}
          >
            <Play size={10} /> Resume & run
          </button>
        )}
        {running && (
          <button
            type="button"
            className="btn-secondary btn-xs"
            onClick={() => {
              stopRef.current = true;
              setStatusLine("Stopping after the current send…");
            }}
          >
            <Square size={9} /> Stop
          </button>
        )}
      </div>
      {running && (
        <span className="inline-flex items-center gap-1 text-12 text-amber">
          <LoaderCircle size={9} className="spin" /> {statusLine || "Running in this tab…"}
        </span>
      )}
      {!running && statusLine && (
        <span className="text-12 text-faint">{statusLine}</span>
      )}
      {error && <span className="max-w-[260px] text-right text-12 text-rust">{error}</span>}
      {campaign.status === "active" && !running && (
        <span className="inline-flex items-center gap-1 text-12 text-faint">
          <Clock3 size={8} /> Keep this tab open while running.
        </span>
      )}
    </div>
  );
}
