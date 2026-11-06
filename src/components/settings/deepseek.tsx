"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CircleCheck,
  CircleAlert,
  KeyRound,
  LoaderCircle,
  PlugZap,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { apiRequest, InlineError } from "../client-ui";
import { Notice } from "../ui";

export interface DeepSeekPublicState {
  configured: boolean;
  source: "database" | "environment" | null;
  baseUrl: string;
  model: string;
  searchPath: string | null;
  fetchPath: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  lastTestedAt: string | null;
}

/**
 * Models the last connection test discovered, so a founder configuring a custom
 * endpoint can pick a name the host actually serves instead of guessing one.
 */
interface TestOutcome {
  models: string[];
  searchOk: boolean;
  fetchOk: boolean;
  searchPath: string | null;
  fetchPath: string | null;
}

/**
 * DeepSeek provider configuration.
 *
 * The API key is written straight to the server and never read back: the UI only
 * ever receives whether a key exists, where it came from, and the result of the
 * last real connection test. This is the credential the autonomous engine uses.
 */
export function DeepSeekSettings({ initial }: { initial: DeepSeekPublicState }) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [model, setModel] = useState(initial.model);
  const [pending, setPending] = useState<"save" | "test" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const [searchPath, setSearchPath] = useState(initial.searchPath ?? "");
  const [fetchPath, setFetchPath] = useState(initial.fetchPath ?? "");

  async function save() {
    setPending("save");
    setError(null);
    setMessage(null);
    try {
      const data = (await apiRequest("/api/settings/deepseek", {
        method: "PUT",
        body: {
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          baseUrl,
          model,
          searchPath: searchPath.trim() || null,
          fetchPath: fetchPath.trim() || null,
        },
      })) as DeepSeekPublicState;
      setState(data);
      setApiKey("");
      setMessage("DeepSeek settings saved. The key is encrypted at rest.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save settings.");
    } finally {
      setPending(null);
    }
  }

  async function test() {
    setPending("test");
    setError(null);
    setMessage(null);
    try {
      const data = await apiRequest("/api/settings/deepseek/test", { body: {} });
      setState(data.settings as DeepSeekPublicState);
      setModels(Array.isArray(data.models) ? (data.models as string[]) : []);
      setOutcome({
        models: Array.isArray(data.models) ? (data.models as string[]) : [],
        searchOk: Boolean(data.searchOk),
        fetchOk: Boolean(data.fetchOk),
        searchPath: (data.searchPath as string | null) ?? null,
        fetchPath: (data.fetchPath as string | null) ?? null,
      });
      // Adopt any path the test discovered, so it is visible and re-savable.
      if (typeof data.searchPath === "string") setSearchPath(data.searchPath);
      if (typeof data.fetchPath === "string") setFetchPath(data.fetchPath);
      setMessage(
        `${data.message} Cost of this test: $${Number(data.costUsd).toFixed(4)}.`,
      );
      router.refresh();
    } catch (caught) {
      // A failed test still tells us a lot: keep any model list we already have
      // so the founder can correct the name rather than start over.
      setOutcome(null);
      setError(caught instanceof Error ? caught.message : "Connection test failed.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="rounded-2xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-forest" />
            <h3 className="text-14 font-bold tracking-[-0.01em] text-ink">
              DeepSeek research provider
            </h3>
          </div>
          <p className="mt-1 max-w-xl text-12 leading-5 text-muted">
            Powers autonomous discovery: Search finds candidate businesses, Fetch
            retrieves official evidence, and the model verifies a paid signal
            offering and writes the first-contact draft.
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-12 font-bold uppercase tracking-[0.12em] ${
            state.configured
              ? "border-forest/25 bg-lime/25 text-forest"
              : "border-amber/30 bg-amber/10 text-amber"
          }`}
        >
          {state.configured ? <CircleCheck size={10} /> : <CircleAlert size={10} />}
          {state.configured ? `Configured (${state.source})` : "Not configured"}
        </span>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="deepseek-key">
            API key
          </label>
          <input
            id="deepseek-key"
            type="password"
            autoComplete="off"
            className="input"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={
              state.configured
                ? "Stored and encrypted — leave blank to keep it"
                : "sk-…"
            }
          />
          <p className="mt-1.5 text-12 leading-4 text-faint">
            Encrypted with AES-256-GCM before storage and never returned to the
            browser.
          </p>
        </div>
        <div>
          <label className="label" htmlFor="deepseek-model">
            Model
          </label>
          <input
            id="deepseek-model"
            className="input"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder="deepseek-flash"
            list="deepseek-model-options"
          />
          {models.length > 0 && (
            <datalist id="deepseek-model-options">
              {models.map((entry) => (
                <option key={entry} value={entry} />
              ))}
            </datalist>
          )}
          <p className="mt-1.5 text-12 leading-4 text-faint">
            Vendor-prefixed names are supported, for example{" "}
            <code>deepseek/deepseek-chat</code>.
            {models.length > 0 && (
              <>
                {" "}
                The test found {models.length} model
                {models.length === 1 ? "" : "s"} on this endpoint.
              </>
            )}
          </p>
        </div>
        <div>
          <label className="label" htmlFor="deepseek-base">
            Base URL
          </label>
          <input
            id="deepseek-base"
            className="input"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://api.deepseek.com"
          />
          <p className="mt-1.5 text-12 leading-4 text-faint">
            A trailing <code>/v1</code> is stripped automatically. Any
            DeepSeek-compatible host works. If it implements Search and Fetch at
            different paths, leave the two fields below blank and the test will
            find them.
          </p>
        </div>
        <div>
          <label className="label" htmlFor="deepseek-search-path">
            Search path <span className="text-faint">(optional)</span>
          </label>
          <input
            id="deepseek-search-path"
            className="input"
            value={searchPath}
            onChange={(event) => setSearchPath(event.target.value)}
            placeholder="/v1/tools/search"
          />
        </div>
        <div>
          <label className="label" htmlFor="deepseek-fetch-path">
            Fetch path <span className="text-faint">(optional)</span>
          </label>
          <input
            id="deepseek-fetch-path"
            className="input"
            value={fetchPath}
            onChange={(event) => setFetchPath(event.target.value)}
            placeholder="/v1/tools/fetch"
          />
        </div>
      </div>

      {models.length > 0 && (
        <div className="mt-4">
          <div className="label">Models reported by this endpoint</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {models.slice(0, 24).map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => setModel(entry)}
                className={`rounded-full border px-2.5 py-1 text-12 font-semibold transition ${
                  entry === model
                    ? "border-forest bg-forest text-lime"
                    : "border-line bg-white/60 text-muted hover:border-ink/30"
                }`}
                title={`Use ${entry}`}
              >
                {entry}
              </button>
            ))}
          </div>
        </div>
      )}

      {state.lastTestMessage && (
        <p className="mt-3 text-12 leading-5 text-muted">
          <span className="font-semibold text-ink">Last test:</span>{" "}
          {state.lastTestMessage}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={pending !== null}
          className="btn-primary btn-sm"
        >
          {pending === "save" ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <KeyRound size={13} />
          )}
          {pending === "save" ? "Saving…" : "Save DeepSeek settings"}
        </button>
        <button
          type="button"
          onClick={test}
          disabled={pending !== null || !state.configured}
          className="btn-secondary btn-sm"
          title={!state.configured ? "Save a key first" : undefined}
        >
          {pending === "test" ? (
            <LoaderCircle size={13} className="spin" />
          ) : (
            <PlugZap size={13} />
          )}
          {pending === "test" ? "Testing…" : "Test chat, Search, Fetch and models"}
        </button>
        <span className="text-12 text-faint">
          The test checks the model list, one tiny real chat completion, Search and Fetch.
        </span>
      </div>

      {outcome && (
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {[
            { label: "Model list", ok: outcome.models.length > 0 },
            { label: "Search", ok: outcome.searchOk },
            { label: "Fetch", ok: outcome.fetchOk },
          ].map((capability) => (
            <div
              key={capability.label}
              className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-12 font-semibold ${
                capability.ok
                  ? "border-forest/25 bg-lime/20 text-forest"
                  : "border-amber/30 bg-amber/10 text-amber"
              }`}
            >
              {capability.ok ? <CircleCheck size={11} /> : <CircleAlert size={11} />}
              {capability.label} {capability.ok ? "working" : "unavailable"}
            </div>
          ))}
        </div>
      )}

      {outcome && !outcome.searchOk && (
        <p className="mt-2 text-12 leading-5 text-muted">
          This endpoint did not answer Search at any path we tried. Set the
          Search and Fetch paths above if this host names them differently, or
          use <code>https://api.deepseek.com</code>, which implements them
          directly.
        </p>
      )}
      {outcome?.searchPath && outcome.searchOk && (
        <p className="mt-2 text-12 leading-5 text-muted">
          Detected on this endpoint: Search at <code>{outcome.searchPath}</code>
          {outcome.fetchPath ? (
            <>
              , Fetch at <code>{outcome.fetchPath}</code>
            </>
          ) : null}
          .
        </p>
      )}

      {message && (
        <div className="mt-3">
          <Notice tone="success">{message}</Notice>
        </div>
      )}
      <InlineError>{error}</InlineError>

      <div className="mt-4 flex items-start gap-2 rounded-xl border border-line bg-paper/60 p-3">
        <ShieldCheck size={13} className="mt-0.5 shrink-0 text-forest" />
        <p className="text-12 leading-5 text-muted">
          Search and Fetch are billed at $0.75 per 1,000 successful requests; model
          calls are billed per token. The engine records every real operation and
          pauses safely when a job&apos;s budget is reached.
        </p>
      </div>
    </div>
  );
}
