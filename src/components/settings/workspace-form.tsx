"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Save } from "lucide-react";
import { listTimezones } from "@/lib/dates/timezone";
import type { WorkspaceSettings } from "@/lib/services/settings";
import { apiRequest, InlineError } from "../client-ui";
import { Notice } from "../ui";

export function WorkspaceSettingsForm({
  settings,
  appUrl,
}: {
  settings: WorkspaceSettings;
  appUrl: string;
}) {
  const router = useRouter();
  const [legalBusinessName, setLegalBusinessName] = useState(
    settings.legalBusinessName,
  );
  const [postalAddress, setPostalAddress] = useState(settings.postalAddress);
  const [senderSignature, setSenderSignature] = useState(settings.senderSignature);
  const [footerNote, setFooterNote] = useState(settings.footerNote);
  const [followUpMax, setFollowUpMax] = useState(settings.followUpMax);
  const [followUpAutoEnabled, setFollowUpAutoEnabled] = useState(
    settings.followUpAutoEnabled,
  );
  const [followUpDailyLimit, setFollowUpDailyLimit] = useState(
    settings.followUpDailyLimit,
  );
  const [followUpsDue, setFollowUpsDue] = useState<number | null>(null);
  const [timezone, setTimezone] = useState(settings.timezone);
  const [timezoneOptions] = useState(() =>
    Array.from(new Set([...listTimezones(), settings.timezone])).sort(),
  );

  // How many leads the job would draft for right now. Read once: the number is context for the switch,
  // not something this form changes.
  useEffect(() => {
    let live = true;
    fetch("/api/follow-ups", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!live || !data) return;
        const due = data.due ?? data.overview?.due ?? data.waiting ?? null;
        setFollowUpsDue(typeof due === "number" ? due : null);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const [delay1, setDelay1] = useState(settings.followUpDelay1Days);
  const [delay2, setDelay2] = useState(settings.followUpDelay2Days);
  const [syncStaleHours, setSyncStaleHours] = useState(settings.syncStaleHours);
  const [researchBudget, setResearchBudget] = useState(
    settings.researchDefaultBudgetUsd,
  );
  const [researchConcurrency, setResearchConcurrency] = useState(
    settings.researchDefaultConcurrency,
  );
  const [searchQps, setSearchQps] = useState(settings.deepseekSearchQps);
  const [fetchQps, setFetchQps] = useState(settings.deepseekFetchQps);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest("/api/settings", {
        method: "PUT",
        body: {
          legalBusinessName,
          postalAddress,
          senderSignature,
          footerNote,
          followUpMax,
          followUpAutoEnabled,
          followUpDailyLimit,
          followUpDelay1Days: delay1,
          followUpDelay2Days: delay2,
          syncStaleHours,
          timezone,
          researchDefaultBudgetUsd: researchBudget,
          researchDefaultConcurrency: researchConcurrency,
          deepseekSearchQps: searchQps,
          deepseekFetchQps: fetchQps,
        },
      });
      setNotice("Sending identity, follow-up rules and research limits saved.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save settings.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-5">
      {!postalAddress.trim() && (
        <Notice tone="warning" title="Live sending will be blocked.">
          A truthful business postal address is required in every commercial
          email footer. Sandbox sends can still be tested without it.
        </Notice>
      )}
      <div>
        <label className="label" htmlFor="workspace-timezone">
          Workspace timezone
        </label>
        <input
          id="workspace-timezone"
          className="input"
          list="workspace-timezones"
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
          required
        />
        <datalist id="workspace-timezones">
          {timezoneOptions.map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
        <p className="field-hint">
          Stored in UTC. This timezone controls displayed dates, Added day
          filters, follow-up timing and daily sending limits.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label">Legal business name</label>
          <input
            className="input"
            value={legalBusinessName}
            onChange={(event) => setLegalBusinessName(event.target.value)}
          />
        </div>
        <div>
          <label className="label">Registered postal address</label>
          <input
            className="input"
            value={postalAddress}
            onChange={(event) => setPostalAddress(event.target.value)}
            placeholder="Required for live commercial email"
          />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label">Founder signature</label>
          <textarea
            className="textarea min-h-[90px]"
            value={senderSignature}
            onChange={(event) => setSenderSignature(event.target.value)}
          />
          <p className="field-hint">Added below AI and founder-written drafts.</p>
        </div>
        <div>
          <label className="label">Footer note</label>
          <textarea
            className="textarea min-h-[90px]"
            value={footerNote}
            onChange={(event) => setFooterNote(event.target.value)}
          />
          <p className="field-hint">
            The unsubscribe link is added separately by the server and cannot be
            removed by an AI draft.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-paper/40 p-4">
        <div className="text-12 font-bold uppercase tracking-[0.12em] text-faint">
          Follow-up policy
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <div>
            <label className="label">Automatic follow-ups</label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={followUpAutoEnabled}
                onChange={(event) => setFollowUpAutoEnabled(event.target.checked)}
              />
              <span>Draft follow-ups for me</span>
            </label>
            <p className="field-hint">
              Off means the follow-up job drafts nothing at all — nothing automatic is written for a lead
              until you switch this on.
              {followUpsDue === null
                ? ""
                : ` ${followUpsDue} lead${followUpsDue === 1 ? "" : "s"} due right now.`}
            </p>
          </div>
          <div>
            <label className="label">Follow-ups per day</label>
            <input
              type="number"
              min={0}
              max={50}
              className="input"
              value={followUpDailyLimit}
              onChange={(event) =>
                setFollowUpDailyLimit(Number(event.target.value))
              }
            />
            <p className="field-hint">
              At most this many a day, newest last send first, so recent contacts come first and the oldest
              backlog last. 0 means none even when the switch is on.
            </p>
          </div>
          <div>
            <label className="label">Follow-ups</label>
            <select
              className="select"
              value={followUpMax}
              onChange={(event) => setFollowUpMax(Number(event.target.value))}
            >
              <option value={0}>None</option>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </div>
          <div>
            <label className="label">First after (days)</label>
            <input
              type="number"
              min={1}
              max={60}
              className="input"
              value={delay1}
              onChange={(event) => setDelay1(Number(event.target.value))}
              disabled={followUpMax === 0}
            />
          </div>
          <div>
            <label className="label">Next after (days)</label>
            <input
              type="number"
              min={1}
              max={60}
              className="input"
              value={delay2}
              onChange={(event) => setDelay2(Number(event.target.value))}
              disabled={followUpMax < 2}
            />
          </div>
          <div>
            <label className="label">Sync stale after (h)</label>
            <input
              type="number"
              min={1}
              max={720}
              className="input"
              value={syncStaleHours}
              onChange={(event) => setSyncStaleHours(Number(event.target.value))}
            />
          </div>
        </div>
        <p className="mt-3 text-12 leading-5 text-muted">
          {followUpMax === 0
            ? "Follow-ups are disabled. Replies and opt-outs still stop any existing prepared drafts."
            : `A thread waits ${delay1} day${delay1 === 1 ? "" : "s"} after contact, then ${delay2} day${delay2 === 1 ? "" : "s"} between later follow-ups. Any reply, opt-out or suppression stops the sequence.`}
        </p>
      </div>

      <div className="rounded-xl border border-line p-4">
        <div className="text-12 font-bold uppercase tracking-[0.12em] text-faint">
          Autonomous research defaults
        </div>
        <p className="mt-1.5 text-12 leading-5 text-muted">
          Applied to every new DeepSeek research target. Existing jobs keep the
          budget they started with.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label">Default budget (USD)</label>
            <input
              type="number"
              min={0.05}
              max={1000}
              step={0.5}
              className="input"
              value={researchBudget}
              onChange={(event) => setResearchBudget(Number(event.target.value))}
            />
          </div>
          <div>
            <label className="label">Concurrency</label>
            <input
              type="number"
              min={1}
              max={8}
              className="input"
              value={researchConcurrency}
              onChange={(event) => setResearchConcurrency(Number(event.target.value))}
            />
          </div>
          <div>
            <label className="label">Search QPS</label>
            <input
              type="number"
              min={1}
              max={5}
              className="input"
              value={searchQps}
              onChange={(event) => setSearchQps(Number(event.target.value))}
            />
          </div>
          <div>
            <label className="label">Fetch QPS</label>
            <input
              type="number"
              min={1}
              max={5}
              className="input"
              value={fetchQps}
              onChange={(event) => setFetchQps(Number(event.target.value))}
            />
          </div>
        </div>
        <p className="mt-2 text-12 leading-4 text-faint">
          DeepSeek documents a limit of 5 requests per second per account for
          Search and for Fetch. Growth refuses values above 5.
        </p>
      </div>

      <div className="rounded-xl border border-line bg-[#fffefb] p-4">
        <div className="text-12 font-bold uppercase tracking-[0.12em] text-faint">
          Footer preview
        </div>
        <div className="mt-2 whitespace-pre-wrap text-12 leading-5 text-muted">
          {`--\n${legalBusinessName} · ${postalAddress || "[postal address missing]"}\n${footerNote}\nUnsubscribe: ${appUrl}/unsubscribe/…`}
        </div>
      </div>

      <InlineError>{error}</InlineError>
      {notice && (
        <div className="rounded-lg border border-forest/20 bg-lime/15 px-3 py-2 text-12 text-forest">
          {notice}
        </div>
      )}
      <div className="flex justify-end border-t border-line pt-4">
        <button type="submit" className="btn-primary" disabled={pending}>
          {pending ? <LoaderCircle size={13} className="spin" /> : <Save size={13} />}
          {pending ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}
