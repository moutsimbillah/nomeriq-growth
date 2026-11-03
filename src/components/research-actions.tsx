"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, LoaderCircle, Pause, Play, Plus, Target } from "lucide-react";
import { CATEGORIES, type Category, type ResearchJob } from "@/lib/types";
import { apiRequest, InlineError, Modal, SubmitBar } from "./client-ui";
import { Notice } from "./ui";

const TARGET_PRESETS = [25, 50, 100, 250];

export function NewResearchButton({
  defaultOpen = false,
}: {
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(defaultOpen);
  const [name, setName] = useState("Batch 02 — new commercial signal providers");
  const [target, setTarget] = useState(100);
  const [categories, setCategories] = useState<Category[]>([
    "forex",
    "metals",
    "crypto",
    "indices",
    "commodities",
  ]);
  const [regions, setRegions] = useState("Worldwide — include non-English markets");
  const [requirements, setRequirements] = useState(
    "Only paid trading-signal providers with a source-confirmed public business email. Exclude brokers, education-only, stocks/options-only, indicators, bots, copy-trading-only, news sites and general communities. Verify one business per record.",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setPending(true);
    setError(null);
    try {
      await apiRequest("/api/research", {
        body: {
          name,
          targetCount: Number(target),
          categories,
          regions,
          requirements,
          notes: "",
        },
      });
      setOpen(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create job.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn-primary"
        onClick={() => setOpen(true)}
      >
        <Plus size={14} />
        New research target
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create a persistent research target"
        description="The target and all progress live in the Growth database. Assistants resume from this record instead of rebuilding a list."
        width="lg"
      >
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
            <div>
              <label className="label" htmlFor="job-name">
                Target name
              </label>
              <input
                id="job-name"
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Batch 02 — 100 global providers"
              />
            </div>
            <div>
              <label className="label" htmlFor="job-target">
                Verified leads
              </label>
              <input
                id="job-target"
                type="number"
                min={1}
                max={10000}
                className="input"
                value={target}
                onChange={(event) => setTarget(Number(event.target.value))}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {TARGET_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setTarget(preset)}
                className={`rounded-full border px-3 py-1.5 text-[10.5px] font-semibold transition ${
                  target === preset
                    ? "border-forest bg-forest text-lime"
                    : "border-line bg-white/60 text-muted hover:border-ink/30"
                }`}
              >
                {preset} leads
              </button>
            ))}
          </div>

          <div>
            <div className="label">Markets in scope</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {CATEGORIES.map((category) => {
                const active = categories.includes(category.value);
                return (
                  <button
                    type="button"
                    key={category.value}
                    onClick={() =>
                      setCategories((current) =>
                        active
                          ? current.filter((value) => value !== category.value)
                          : [...current, category.value],
                      )
                    }
                    className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-[11.5px] font-semibold transition ${
                      active
                        ? "border-forest/25 bg-lime/25 text-forest"
                        : "border-line bg-white/50 text-muted hover:border-ink/25"
                    }`}
                  >
                    <span
                      className={`grid h-3.5 w-3.5 place-items-center rounded-[4px] border ${
                        active ? "border-forest bg-forest text-lime" : "border-line-strong"
                      }`}
                    >
                      {active && <span className="h-1.5 w-1.5 rounded-[1px] bg-lime" />}
                    </span>
                    {category.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="label" htmlFor="job-regions">
              Regions and languages
            </label>
            <input
              id="job-regions"
              className="input"
              value={regions}
              onChange={(event) => setRegions(event.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="job-requirements">
              Qualification brief
            </label>
            <textarea
              id="job-requirements"
              className="textarea min-h-[110px]"
              value={requirements}
              onChange={(event) => setRequirements(event.target.value)}
            />
          </div>

          <Notice tone="info">
            Growth does not pretend this runs on its own. The target stays
            resumable while a connected ChatGPT/Claude session, or the founder,
            does the actual public research.
          </Notice>
          <InlineError>{error}</InlineError>
          <SubmitBar>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={create}
              disabled={pending || categories.length === 0 || !name.trim()}
            >
              {pending ? <LoaderCircle size={14} className="spin" /> : <Target size={14} />}
              {pending ? "Creating…" : "Create target"}
              {!pending && <ArrowRight size={14} />}
            </button>
          </SubmitBar>
        </div>
      </Modal>
    </>
  );
}

export function JobStatusButton({
  job,
}: {
  job: Pick<ResearchJob, "id" | "status">;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextStatus =
    job.status === "active" ? "paused" : job.status === "paused" ? "active" : null;

  if (!nextStatus) return null;

  async function update() {
    setPending(true);
    setError(null);
    try {
      await apiRequest(`/api/research/${job.id}`, {
        method: "PATCH",
        body: { status: nextStatus },
      });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Update failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={update}
        disabled={pending}
        className="btn-secondary btn-xs"
      >
        {pending ? (
          <LoaderCircle size={11} className="spin" />
        ) : nextStatus === "paused" ? (
          <Pause size={11} />
        ) : (
          <Play size={11} />
        )}
        {nextStatus === "paused" ? "Pause" : "Resume"}
      </button>
      {error && <span className="text-[9.5px] text-rust">{error}</span>}
    </div>
  );
}
