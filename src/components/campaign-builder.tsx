"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { apiRequest } from "./client-ui";
import { Card, SectionHeading } from "./ui";
import { useWorkspaceTimezone } from "./workspace-timezone";
import {
  CampaignBatchApprovedNotice,
  CampaignBuilderPanel,
  type CampaignBuilderFilters,
} from "./campaign-ui";
import {
  NO_PER_MINUTE_LABEL,
  PER_MINUTE_RANGE_HINT,
  perMinuteSummary,
} from "@/lib/campaigns/pacing";
import { zonedWallClockToUtc } from "@/lib/dates/timezone";
import type { CampaignBatchPreview, CampaignBatchResult } from "@/lib/services/campaigns";

export interface CampaignAccountOption {
  id: string;
  emailAddress: string;
  provider: string;
  status: string;
}

type Filters = CampaignBuilderFilters;

const EMPTY_FILTERS: Filters = {
  agent: "",
  market: "",
  stage: "",
  tier: "",
  sender: "",
  hasEmail: false,
  notContacted: true,
};

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

/** What the founder is told after the "only the ones that pass" click: the reduced count, the excluded. */
type PassingOutcome = {
  approved: number;
  excluded: Array<{ draftId: string; prospectName: string; message: string }>;
};

/**
 * The campaign builder: pick filters, watch a live count, set a batch size, choose a start and a
 * per-minute limit, then one button approves and queues exactly that many emails. The count comes from
 * the preview endpoint (the same query the creation uses), never from a local guess, and the approve
 * button refuses to appear until every selected draft passes the mechanical check.
 *
 * All state, the preview fetch and the one approval call live here; the form itself is presentational
 * (`CampaignBuilderPanel`), which is what keeps "the controls sit above the candidate list" testable
 * against the real markup. When drafts fail the check the panel offers ONE explicit alternative —
 * approve only the ones that pass, with the reduced count stated — and this container sends
 * `approvePassingOnly: true` for that click alone, then names the excluded drafts again in the outcome
 * notice. Nothing is ever excluded without that click.
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
  const [preview, setPreview] = useState<CampaignBatchPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [passingOutcome, setPassingOutcome] = useState<PassingOutcome | null>(null);
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
  // How many DISTINCT drafts the check refuses (a draft with two problems is still one draft left out).
  const failingDraftCount = preview?.failingPreviews?.length ?? 0;
  const passingCount = Math.max(0, queueCount - failingDraftCount);

  const perMinuteEmpty = perMinute.trim() === "";
  const perMinuteNumber = perMinuteEmpty ? null : Number(perMinute);
  const perMinuteBad = !perMinuteEmpty && !Number.isInteger(perMinuteNumber as number);

  /**
   * The one approval action. `passingOnly` is the founder's own explicit click on the alternative: it
   * re-forms the batch to the drafts that passed and queues only those, at the count stated on screen.
   * Without that click a single failing draft still refuses the whole batch, unchanged.
   */
  async function approve(options: { passingOnly?: boolean } = {}) {
    const passingOnly = options.passingOnly === true;
    setError(null);
    setNotice(null);
    setPassingOutcome(null);
    if (!name.trim()) return setError("Give the campaign a name.");
    if (!accountId) return setError("Connect a sending account first.");
    if (!preview || queueCount < 1) return setError("No drafts match — nothing to approve.");
    if (!passingOnly && failingCount > 0) {
      return setError("Some drafts failed the check. Fix them before approving.");
    }
    if (passingOnly && passingCount < 1) {
      return setError("Every selected draft failed the check — there is nothing to approve.");
    }
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
      const result = await apiRequest("/api/campaigns", {
        body: {
          name: name.trim(),
          accountId,
          filters: JSON.parse(filtersKey),
          limit: Math.max(1, Math.min(requestedSize || queueCount, matches || 1)),
          scheduledAt,
          perMinuteCap: perMinuteNumber,
          approveBatch: true,
          // Only the founder's click on the alternative carries this; the primary action never does.
          approvePassingOnly: passingOnly,
          authorize: true,
        },
      }) as CampaignBatchResult;
      if (passingOnly && result.excludedFailing.length > 0) {
        setPassingOutcome({ approved: result.approvedCount, excluded: result.excludedFailing });
      } else {
        setNotice(
          scheduledAt
            ? `Approved and queued ${result.approvedCount} email${result.approvedCount === 1 ? "" : "s"}; it starts itself at the scheduled time.`
            : `Approved and queued ${result.approvedCount} email${result.approvedCount === 1 ? "" : "s"}. It starts when you press Start.`,
        );
      }
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
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={() => {
              setNotice(null);
              setPassingOutcome(null);
              setOpen(true);
            }}
          >
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

      {passingOutcome && (
        <CampaignBatchApprovedNotice
          approved={passingOutcome.approved}
          excluded={passingOutcome.excluded}
        />
      )}

      {open && (
        <CampaignBuilderPanel
          accounts={accounts}
          name={name}
          accountId={accountId}
          filters={filters}
          batchSize={batchSize}
          timing={timing}
          whenLocal={whenLocal}
          perMinute={perMinute}
          perMinuteSummary={perMinuteEmpty ? NO_PER_MINUTE_LABEL : perMinuteSummary(perMinuteNumber)}
          perMinuteHint={PER_MINUTE_RANGE_HINT}
          timezone={timezone}
          preview={preview}
          previewLoading={previewLoading}
          previewError={previewError}
          error={error}
          matches={matches}
          overMatched={overMatched}
          queueCount={queueCount}
          failingCount={failingCount}
          passingCount={passingCount}
          pending={pending}
          onNameChange={setName}
          onAccountChange={setAccountId}
          onFilterChange={setFilter}
          onBatchSizeChange={setBatchSize}
          onTimingChange={setTiming}
          onWhenChange={setWhenLocal}
          onPerMinuteChange={setPerMinute}
          onApprove={() => void approve()}
          onApprovePassingOnly={() => void approve({ passingOnly: true })}
          onClose={() => setOpen(false)}
        />
      )}
    </Card>
  );
}

/** Kept so a caller that only knows the label can still render the exact empty-state sentence. */
export const CAMPAIGN_NO_PER_MINUTE_LABEL = NO_PER_MINUTE_LABEL;
