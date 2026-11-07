"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ResearchConfiguration } from "@/lib/services/research-routing";
import { apiRequest, InlineError } from "./client-ui";

export function ResearchConnectionCard({ configuration }: { configuration: ResearchConfiguration }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string | null; results: { provider: string; model: string; ok: boolean; message: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function test() {
    setPending(true); setError(null); setOutcome(null);
    try {
      setOutcome(await apiRequest("/api/research/test-connection", { body: {} }));
      router.refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Connection test failed."); }
    finally { setPending(false); }
  }
  return <section className="mb-4 rounded-2xl border border-line bg-panel p-5" aria-label="Research engine configuration">
    <h2 className="text-16 font-bold">Research engine</h2>
    <div className="mt-2 space-y-1 break-words text-12 text-muted">
      <p>Assigned: {configuration.assigned ? `${configuration.assigned.name} · ${configuration.assigned.model}` : "Not assigned"}</p>
      <p>Selected: {configuration.selected ? `${configuration.selected.name} · ${configuration.selected.model}` : "Unavailable"}</p>
      <p>Search / Fetch: {configuration.search?.name ?? "Chosen model's own source"}</p>
      <p>{configuration.configured ? "Configured — connection is checked only when you click Test connection." : configuration.error}</p>
      {configuration.warnings.map(warning => <p key={warning} className="text-amber">{warning}</p>)}
    </div>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" className="btn-secondary btn-sm" disabled={pending || !configuration.chain.length} onClick={() => void test()}>{pending ? "Testing…" : "Test connection"}</button>
      <Link href="/settings#providers" className="btn-ghost btn-sm">Settings → AI providers</Link>
    </div>
    <p className="mt-2 text-12 text-faint">Tests the selected provider, effective task model and Search / Fetch source. Uses provider requests; never starts research.</p>
    {outcome && <div role="status" className="mt-3 space-y-1 break-words text-12">
      <p>{outcome.ok ? "Connection test passed." : "Connection test did not pass."} {outcome.message}</p>
      {outcome.results.map((result, index) => <p key={index}>{result.provider} · {result.model}: {result.ok ? "Passed" : "Failed"} — {result.message}</p>)}
      {!outcome.ok && <Link href="/settings#providers" className="underline">Check AI providers in Settings</Link>}
    </div>}
    <InlineError>{error}</InlineError>
  </section>;
}
