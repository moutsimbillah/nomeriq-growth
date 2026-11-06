"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Save } from "lucide-react";

import { apiRequest, InlineError } from "../client-ui";
import { Notice } from "../ui";

export interface ResearchEngineView {
  budgetUsd: number;
  concurrency: number;
  searchQps: number;
  fetchQps: number;
  /** The lead-research assignment, so a search-source change keeps its provider and model. */
  leadResearch: { providerId: string | null; model: string | null; searchProviderId: string | null };
  /** Providers from the AI providers list that can search (search-only or chat + search). */
  searchProviders: { id: string; name: string; isEnabled: boolean }[];
}

/**
 * The built-in research engine's own limits, kept apart from the provider list: budget per job,
 * concurrency, the Search and Fetch rate limits, and where research searches — pointing at a provider
 * from the list rather than holding a key of its own.
 *
 * The rate limits are capped at 5 here, in the settings validation and by the database CHECK; DeepSeek
 * documents 5 requests per second per account (AGENTS.md rule 4).
 */
export function ResearchEngineCard({ initial }: { initial: ResearchEngineView }) {
  const router = useRouter();
  const [budget, setBudget] = useState(initial.budgetUsd);
  const [concurrency, setConcurrency] = useState(initial.concurrency);
  const [searchQps, setSearchQps] = useState(initial.searchQps);
  const [fetchQps, setFetchQps] = useState(initial.fetchQps);
  const [searchSource, setSearchSource] = useState(initial.leadResearch.searchProviderId ?? "");
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
          researchDefaultBudgetUsd: budget,
          researchDefaultConcurrency: concurrency,
          deepseekSearchQps: searchQps,
          deepseekFetchQps: fetchQps,
        },
      });
      if ((searchSource || null) !== (initial.leadResearch.searchProviderId ?? null)) {
        await apiRequest("/api/settings/ai-tasks", {
          body: {
            task: "lead_research",
            providerId: initial.leadResearch.providerId,
            model: initial.leadResearch.model,
            searchProviderId: searchSource || null,
          },
        });
      }
      setNotice("Research engine settings saved. Existing jobs keep the budget they started with.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the research engine settings.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3" data-research-engine>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label" htmlFor="engine-budget">Budget per job (USD)</label>
          <input id="engine-budget" type="number" min={0.05} max={1000} step={0.5} className="input"
            value={budget} onChange={(event) => setBudget(Number(event.target.value))} />
        </div>
        <div>
          <label className="label" htmlFor="engine-concurrency">Concurrency</label>
          <input id="engine-concurrency" type="number" min={1} max={8} className="input"
            value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} />
        </div>
        <div>
          <label className="label" htmlFor="engine-search-qps">Search rate (per second)</label>
          <input id="engine-search-qps" type="number" min={1} max={5} className="input"
            value={searchQps} onChange={(event) => setSearchQps(Number(event.target.value))} />
        </div>
        <div>
          <label className="label" htmlFor="engine-fetch-qps">Fetch rate (per second)</label>
          <input id="engine-fetch-qps" type="number" min={1} max={5} className="input"
            value={fetchQps} onChange={(event) => setFetchQps(Number(event.target.value))} />
        </div>
      </div>
      <div className="max-w-md">
        <label className="label" htmlFor="engine-search-source">Search source</label>
        <select id="engine-search-source" className="select" value={searchSource}
          onChange={(event) => setSearchSource(event.target.value)}>
          <option value="">The research model&apos;s own search</option>
          {initial.searchProviders.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}{provider.isEnabled ? "" : " (disabled)"}
            </option>
          ))}
        </select>
        <p className="mt-1 text-12 text-muted">
          Chosen from the AI providers above — the engine holds no key of its own. Lead research
          {initial.leadResearch.providerId ? " uses the provider assigned under AI actions." : " is not assigned to a provider yet."}
        </p>
      </div>
      <p className="text-12 leading-4 text-faint">
        DeepSeek documents a limit of 5 requests per second per account for Search and for Fetch.
        Growth refuses values above 5. New jobs use the budget and concurrency set here.
      </p>
      <InlineError>{error}</InlineError>
      {notice && <Notice tone="success">{notice}</Notice>}
      <div className="flex justify-end border-t border-line pt-3">
        <button type="submit" className="btn-primary" disabled={pending}>
          {pending ? <LoaderCircle size={13} className="spin" /> : <Save size={13} />}
          {pending ? "Saving…" : "Save research engine"}
        </button>
      </div>
    </form>
  );
}
