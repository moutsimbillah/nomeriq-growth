"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, LoaderCircle, Sparkles } from "lucide-react";
import { apiRequest } from "./client-ui";
import { Card, Notice, SectionHeading } from "./ui";
import { useWorkspaceTimezone } from "./workspace-timezone";
import {
  CampaignApproveButton,
  CampaignBatchPreviewPanel,
  PerMinuteControl,
} from "./campaign-ui";
import {
  NO_PER_MINUTE_LABEL,
  PER_MINUTE_RANGE_HINT,
  perMinuteSummary,
} from "@/lib/campaigns/pacing";
import { zonedWallClockToUtc } from "@/lib/dates/timezone";
import { CATEGORIES, PIPELINE, PIPELINE_LABELS } from "@/lib/types";
import { AGENT_LABELS, AGENT_TAGS } from "@/lib/agent/agentTag";

export interface CampaignAccountOption {
  id: string;
  emailAddress: string;
  provider: string;
  status: string;
}

interface Filters {
  agent: string;
  market: string;
  stage: string;
  tier: string;
  sender: string;
  hasEmail: boolean;
  notContacted: boolean;
}

const EMPTY_FILTERS: Filters = {
  agent: "",
  market: "",
  stage: "",
  tier: "",
  sender: "",
  hasEmail: false,
  notContacted: true,
};

const TIER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "tier_1", label: "Tier 1 — email-first, reachable" },
  { value: "other", label: "Other" },
  { value: "email_no_website", label: "Email, no website" },
  { value: "category_b", label: "Category B — never emailed" },
  { value: "unassessed", label: "Unassessed" },
];

function filterPayload(filters: Filters): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (filters.agent) out.agent = filters.agent;
  if (filters.market) out.market = filters.market;
  if (filters.stage) out.stage = filters.stage;
  if (filters.tier) out.tier = filters.tier;
  if (filters.sender) out.sender = filters.sender;
  if (filters.hasEmail) out.hasEmail = true;
  if (filters.notContacted) out.notContacted = true;
  return out;
}

/**
 * The campaign builder: pick filters, watch a live count, set a batch size, choose a start and a
 * per-minute limit, then one button approves and queues exactly that many emails. The count comes from
 * the preview endpoint (the same query the creation uses), never from a local guess, and the approve
 * button refuses to appear until every selected draft passes the mechanical check.
 */
export function CampaignBuilder({ accounts }: { accounts: CampaignAccountOption[] }) {
  const router = useRouter();
  const timezone = useWorkspaceTimezone();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [accountId, setAccountId] = useState(
    accounts.find((account) => account.status === "connected")?.id || accounts[0]?.id || "",
  );
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [batchSize, setBatchSize] = useState<string>("");
  const [timing, setTiming] = useState<"now" | "at">("now");
  const [whenLocal, setWhenLocal] = useState("");
  const [perMinute, setPerMinute] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const selectedFilters = filterPayload(filters);
  const filtersKey = JSON.stringify(selectedFilters);

  const loadPreview = useCallback(
    async (limit: number) => {
      const seq = ++requestSeq.current;
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const data = await apiRequest("/api/campaigns/preview", {
          body: { filters: JSON.parse(filtersKey), limit },
        });
        if (seq === requestSeq.current) setPreview(data);
      } catch (caught) {
        if (seq === requestSeq.current) {
          setPreviewError(caught instanceof Error ? caught.message : "Could not count matching drafts.");
          setPreview(null);
        }
      } finally {
        if (seq === requestSeq.current) setPreviewLoading(false);
      }
    },
    [filtersKey],
  );

  // A live count as the founder changes filters; a short debounce so typing a number does not spam.
  useEffect(() => {
    if (!open) return;
    const parsed = Number.parseInt(batchSize, 10);
    const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
    const handle = setTimeout(() => void loadPreview(limit), 250);
    return () => clearTimeout(handle);
  }, [open, loadPreview, batchSize]);

  function setFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  const matches: number = preview?.matches ?? 0;
  const parsedSize = Number.parseInt(batchSize, 10);
  const requestedSize = Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : matches;
  const overMatched = Number.isFinite(parsedSize) && parsedSize > matches && matches > 0;
  const queueCount = preview?.selected ?? 0;
  const failingCount = preview?.failing?.length ?? 0;

  const perMinuteEmpty = perMinute.trim() === "";
  const perMinuteNumber = perMinuteEmpty ? null : Number(perMinute);
  const perMinuteBad = !perMinuteEmpty && !Number.isInteger(perMinuteNumber as number);

  async function approve() {
    setError(null);
    setNotice(null);
    if (!name.trim()) return setError("Give the campaign a name.");
    if (!accountId) return setError("Connect a sending account first.");
    if (!preview || queueCount < 1) return setError("No drafts match — nothing to approve.");
    if (failingCount > 0) return setError("Some drafts failed the check. Fix them before approving.");
    if (perMinuteBad) return setError(PER_MINUTE_RANGE_HINT);
    let scheduledAt: string | null = null;
    if (timing === "at") {
      if (!whenLocal) return setError("Choose the date and time to start.");
      try {
        scheduledAt = zonedWallClockToUtc(whenLocal, timezone).toISOString();
      } catch (caught) {
        return setError(caught instanceof Error ? caught.message : "That start time is not valid.");
      }
    }
    setPending(true);
    try {
      await apiRequest("/api/campaigns", {
        body: {
          name: name.trim(),
          accountId,
          filters: JSON.parse(filtersKey),
          limit: Math.max(1, Math.min(requestedSize || queueCount, matches || 1)),
          scheduledAt,
          perMinuteCap: perMinuteNumber,
          approveBatch: true,
          authorize: true,
        },
      });
      setNotice(
        scheduledAt
          ? `Approved and queued ${queueCount} email${queueCount === 1 ? "" : "s"}; it starts itself at the scheduled time.`
          : `Approved and queued ${queueCount} email${queueCount === 1 ? "" : "s"}. It starts when you press Start.`,
      );
      setOpen(false);
      setFilters(EMPTY_FILTERS);
      setBatchSize("");
      setWhenLocal("");
      setPerMinute("");
      setTiming("now");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the campaign.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionHeading
          title="Build a campaign"
          description="Choose who it goes to; Growth counts the matches live. Nothing is approved or queued until you click the one button."
        />
        {!open && (
          <button type="button" className="btn-primary btn-sm" onClick={() => setOpen(true)}>
            <Sparkles size={12} /> New campaign
          </button>
        )}
        {open && (
          <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)}>
            Close
          </button>
        )}
      </div>

      {notice && (
        <div className="mt-3 rounded-xl border border-forest/20 bg-lime/15 px-3 py-2 text-12 text-forest">
          {notice}
        </div>
      )}

      {open && (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="campaign-name">
                Campaign name
              </label>
              <input
                id="campaign-name"
                className="input"
                value={name}
                placeholder="e.g. Tier 1 signals — November"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="campaign-account">
                Send from
              </label>
              <select
                id="campaign-account"
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

          <div className="rounded-xl border border-line bg-paper/40 p-3.5">
            <div className="mb-2 text-12 font-bold uppercase tracking-[0.1em] text-faint">Who it goes to</div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label className="label" htmlFor="filter-tier">
                  Tier
                </label>
                <select
                  id="filter-tier"
                  className="select"
                  value={filters.tier}
                  onChange={(event) => setFilter("tier", event.target.value)}
                >
                  <option value="">Any tier</option>
                  {TIER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="filter-market">
                  Market
                </label>
                <select
                  id="filter-market"
                  className="select"
                  value={filters.market}
                  onChange={(event) => setFilter("market", event.target.value)}
                >
                  <option value="">Any market</option>
                  {CATEGORIES.map((category) => (
                    <option key={category.value} value={category.value}>
                      {category.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="filter-stage">
                  Stage
                </label>
                <select
                  id="filter-stage"
                  className="select"
                  value={filters.stage}
                  onChange={(event) => setFilter("stage", event.target.value)}
                >
                  <option value="">Any stage</option>
                  {PIPELINE.map((stage) => (
                    <option key={stage} value={stage}>
                      {PIPELINE_LABELS[stage]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="filter-sender">
                  Sender
                </label>
                <select
                  id="filter-sender"
                  className="select"
                  value={filters.sender}
                  onChange={(event) => setFilter("sender", event.target.value)}
                >
                  <option value="">Any sender</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.emailAddress}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="filter-agent">
                  Saved by
                </label>
                <select
                  id="filter-agent"
                  className="select"
                  value={filters.agent}
                  onChange={(event) => setFilter("agent", event.target.value)}
                >
                  <option value="">Any agent</option>
                  {AGENT_TAGS.map((tag) => (
                    <option key={tag} value={tag}>
                      {AGENT_LABELS[tag]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-4">
              <label className="inline-flex items-center gap-2 text-12 font-semibold text-ink">
                <input
                  type="checkbox"
                  className="accent-[#11231a]"
                  checked={filters.notContacted}
                  onChange={(event) => setFilter("notContacted", event.target.checked)}
                />
                Not yet contacted
              </label>
              <label className="inline-flex items-center gap-2 text-12 font-semibold text-ink">
                <input
                  type="checkbox"
                  className="accent-[#11231a]"
                  checked={filters.hasEmail}
                  onChange={(event) => setFilter("hasEmail", event.target.checked)}
                />
                Has a contact email
              </label>
            </div>
            <p className="mt-2 text-12 text-faint">
              Every candidate already has a prepared or approved first-contact draft — that is exactly what
              makes it selectable here, so nothing unapproved can slip in.
            </p>
          </div>

          <CampaignBatchPreviewPanel preview={preview} loading={previewLoading} error={previewError} />

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="batch-size">
                Batch size
              </label>
              <input
                id="batch-size"
                className="input w-32"
                inputMode="numeric"
                value={batchSize}
                placeholder={matches ? String(matches) : "All"}
                onChange={(event) => setBatchSize(event.target.value)}
              />
              <p className="mt-1 text-12 text-muted">
                {matches > 0
                  ? `Up to ${matches} match. Leave empty to take them all.`
                  : "Waiting for matches."}
                {overMatched && (
                  <span className="ml-1 font-semibold text-amber">
                    Only {matches} match — the batch will be {matches}.
                  </span>
                )}
              </p>
            </div>
            <div>
              <span className="label">Start</span>
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-2 text-12 font-semibold text-ink">
                  <input
                    type="radio"
                    name="campaign-timing"
                    checked={timing === "now"}
                    onChange={() => setTiming("now")}
                  />
                  Start now
                </label>
                <label className="inline-flex items-center gap-2 text-12 font-semibold text-ink">
                  <input
                    type="radio"
                    name="campaign-timing"
                    checked={timing === "at"}
                    onChange={() => setTiming("at")}
                  />
                  At a date and time
                </label>
              </div>
              {timing === "at" && (
                <input
                  type="datetime-local"
                  className="input mt-2 w-auto"
                  value={whenLocal}
                  aria-label={`Start time, ${timezone}`}
                  onChange={(event) => setWhenLocal(event.target.value)}
                />
              )}
              <p className="mt-1 inline-flex items-center gap-1 text-12 text-faint">
                <CalendarClock size={11} /> Times are {timezone}.{" "}
                {timing === "at"
                  ? "A scheduled campaign starts itself — you do not need to be here."
                  : "A campaign set to start now waits for your Start."}
              </p>
            </div>
          </div>

          <PerMinuteControl
            value={perMinute}
            onChange={setPerMinute}
            summary={perMinuteEmpty ? NO_PER_MINUTE_LABEL : perMinuteSummary(perMinuteNumber)}
            hint={PER_MINUTE_RANGE_HINT}
            id="campaign-per-minute"
          />

          {error && (
            <div className="rounded-xl border border-rust/20 bg-rust/[0.05] px-3 py-2 text-12 leading-5 text-rust">
              {error}
            </div>
          )}

          <Notice tone="info">
            {queueCount > 0 && failingCount === 0
              ? `One click approves these ${queueCount} draft${queueCount === 1 ? "" : "s"} and queues them. A single failure later is skipped and named; only a system failure pauses the campaign.`
              : "Fix any failing draft first — the batch is all-or-nothing, so one bad draft blocks the whole batch."}
          </Notice>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-4">
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <CampaignApproveButton
              count={queueCount}
              disabled={
                pending ||
                queueCount < 1 ||
                failingCount > 0 ||
                !accountId ||
                !name.trim() ||
                previewLoading ||
                (timing === "at" && !whenLocal)
              }
              pending={pending}
              onClick={approve}
            />
          </div>
        </div>
      )}
    </Card>
  );
}

/** Kept so a caller that only knows the label can still render the exact empty-state sentence. */
export const CAMPAIGN_NO_PER_MINUTE_LABEL = NO_PER_MINUTE_LABEL;
