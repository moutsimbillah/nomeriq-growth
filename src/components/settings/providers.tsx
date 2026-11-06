"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Plus, RefreshCw, ShieldCheck, ShieldOff, Trash2 } from "lucide-react";

import { Notice } from "../ui";
import { apiRequest, InlineError, Modal, SubmitBar } from "../client-ui";
import { PROVIDER_CATALOG } from "@/lib/ai/provider-catalog";
import { priorityConflicts } from "@/lib/ai/routing";

export interface ProviderRowView {
  id: string;
  name: string;
  /** The provider slug: `deepseek`, `openai`, `custom`, and so on. */
  provider: string;
  /** `chat`, `search` (Brave) or `both` — what the row can do. Migration 025. */
  kinds: string;
  baseUrl: string;
  model: string;
  priority: number;
  isEnabled: boolean;
  hasKey: boolean;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  lastTestedAt: string | null;
  /** The AI actions and fallback lists that point here, so a delete can name them. */
  usedBy?: string[];
}

/**
 * The provider catalog — which slugs exist and what each defaults to — is imported from
 * `@/lib/ai/provider-catalog` so the screen and the server registry always agree. A test
 * guards the catalog's own invariants (kinds valid, Brave search-only and model-free).
 */
export function ProvidersCard({ initial, canDelete = false }: { initial: ProviderRowView[]; canDelete?: boolean }) {
  const router = useRouter();
  const [noticeOk, setNoticeOk] = useState(true);
  const [models, setModels] = useState<string[]>([]);
  const [rowModels, setRowModels] = useState<Record<string, string[]>>({});
  const [providers, setProviders] = useState<ProviderRowView[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<ProviderRowView | null>(null);
  const [switchTo, setSwitchTo] = useState("");
  const [form, setForm] = useState({
    name: "",
    provider: "deepseek",
    kinds: "both",
    apiKey: "",
    baseUrl: "",
    model: "",
    searchPath: "",
    fetchPath: "",
  });

  async function call(label: string, run: () => Promise<{ providers?: ProviderRowView[] } | null>) {
    setError(null);
    setNotice(null);
    setNoticeOk(true);
    setPending(label);
    try {
      const data = await run();
      if (data?.providers) setProviders(data.providers);
      router.refresh();
      return data;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That did not work.");
      return null;
    } finally {
      setPending(null);
    }
  }

  async function add() {
    const name = form.name.trim();
    const apiKey = form.apiKey.trim();
    if (!name || !apiKey) {
      setError("A provider needs a name and an API key.");
      return;
    }

    const data = await call("add", () =>
      apiRequest("/api/settings/providers", {
        body: {
          name,
          provider: form.provider,
          kinds: form.kinds,
          apiKey,
          baseUrl: form.baseUrl.trim() || undefined,
          model: form.kinds === "search" ? undefined : form.model.trim() || undefined,
          // Optional: left empty, the provider's documented paths are used and Test detects them.
          searchPath: form.kinds !== "chat" && form.searchPath.trim() ? form.searchPath.trim() : undefined,
          fetchPath: form.kinds !== "chat" && form.fetchPath.trim() ? form.fetchPath.trim() : undefined,
        },
      }),
    );

    if (data) {
      setNotice(`Added ${name}. Test it, then choose it under AI actions; testing alone does not assign tasks.`);
      setModels([]);
      setForm({ name: "", provider: "deepseek", kinds: "both", apiKey: "", baseUrl: "", model: "", searchPath: "", fetchPath: "" });
      setAdding(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>, label: string) {
    return call(label, () =>
      apiRequest(`/api/settings/providers/${id}`, { method: "PATCH", body }),
    );
  }

  async function toggle(row: ProviderRowView) {
    const data = await patch(row.id, { isEnabled: !row.isEnabled }, `toggle-${row.id}`);
    if (data) {
      setNotice(
        `${row.name} is now ${row.isEnabled ? "disabled" : "enabled"} in the failover order.`,
      );
    }
  }

  async function savePriority(row: ProviderRowView, value: string) {
    const priority = Number.parseInt(value, 10);
    if (!Number.isFinite(priority) || priority < 1) {
      setError("Priority must be a whole number of 1 or more.");
      return;
    }
    if (priority === row.priority) return;
    await patch(row.id, { priority }, `priority-${row.id}`);
  }

  async function test(row: ProviderRowView) {
    const data = await call(`test-${row.id}`, () =>
      apiRequest(`/api/settings/providers/${row.id}/test`, { body: {} }),
    );
    if (data && "message" in data) {
      const outcome = data as unknown as { ok: boolean; message: string; models?: string[] };
      setNoticeOk(outcome.ok);
      if (outcome.models) setRowModels(current => ({ ...current, [row.id]: outcome.models! }));
      setNotice(`${row.name}: ${outcome.message}`);
    }
  }

  /**
   * A delete is refused while anything still points at the provider, so the dialog offers the move
   * first. The list already knows which rows can chat: enabled, with a passing full Test.
   */
  async function confirmDelete() {
    const row = deleting;
    if (!row) return;
    const target = workingOptions.find(provider => provider.id === switchTo) ?? null;
    const data = await call(`delete-${row.id}`, () =>
      apiRequest(`/api/settings/providers/${row.id}`, {
        method: "DELETE",
        body: { switchToProviderId: switchTo || null },
      }),
    );
    if (data) {
      setNoticeOk(true);
      setNotice(
        target
          ? `${row.name} deleted; its stored key is destroyed, and the actions that used it now use ${target.name}.`
          : `${row.name} deleted. Its stored key is destroyed and cannot be recovered.`,
      );
      setDeleting(null);
      setSwitchTo("");
    }
  }

  async function loadModels() {
    setPending("models");
    setError(null);
    try {
      const data = await apiRequest("/api/settings/provider-models", {
        body: { provider: form.provider, baseUrl: form.baseUrl, apiKey: form.apiKey },
      });
      const listed = Array.isArray(data.models) ? data.models as string[] : [];
      setModels(listed);
      setForm(current => ({ ...current, model: listed.includes(current.model) ? current.model : "" }));
    } catch {
      setError("Could not load models. Check the provider URL and credential.");
    } finally { setPending(null); }
  }

  /**
   * The rows a delete may hand an action to: enabled, test-passed and able to chat. Anything else
   * would leave the action pointing at a provider that cannot answer.
   */
  const workingOptions = providers
    .filter(provider =>
      provider.isEnabled &&
      provider.lastTestOk === true &&
      provider.kinds !== "search" &&
      provider.model.trim().length > 0,
    )
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

  // Two live chat providers on the same number is a real ambiguity, so it is named, not resolved
  // silently: the tie is broken by Test result and then by name.
  const conflicts = priorityConflicts(
    providers.map(provider => ({
      id: provider.id,
      name: provider.name,
      provider: provider.provider,
      kinds: provider.kinds,
      model: provider.model,
      priority: provider.priority,
      isEnabled: provider.isEnabled,
      lastTestOk: provider.lastTestOk,
    })),
  );

  return (
    <div className="mt-4 rounded-xl border border-line bg-white/50 px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-12 font-bold text-ink">Provider failover order</div>
          <p className="text-12 text-muted">
            The engine tries these in order and only stops when every one of them fails. Lowest
            number is tried first. Keys are stored encrypted and never shown again.
          </p>
        </div>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setAdding((value) => !value);
            setError(null);
            setNotice(null);
          }}
        >
          <Plus size={13} />
          {adding ? "Cancel" : "Add provider"}
        </button>
      </div>

      {conflicts.length > 0 && (
        <p className="mt-3 rounded-lg bg-amber/10 px-2.5 py-2 text-12 text-amber" data-priority-conflict>
          Order {conflicts.join(", ")} is shared by more than one live chat provider. They are tried
          test-passed first, then by name, so the order is still defined — but give them distinct
          numbers if you want an exact order.
        </p>
      )}

      {providers.length === 0 ? (
        <p className="mt-3 text-12 text-faint">
          No AI provider yet. Add one below; until then the AI actions use the No-AI fallback.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {providers.map((row) => (
            <div
              key={row.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-line/70 px-2.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="text-12 font-bold text-ink">
                  {row.name}
                  {row.kinds !== "chat" && row.kinds !== "both" && (
                    <span className="ml-2 rounded bg-line/60 px-1.5 py-0.5 text-12 font-medium text-muted">
                      search only
                    </span>
                  )}
                  {row.kinds === "both" && (
                    <span className="ml-2 rounded bg-line/60 px-1.5 py-0.5 text-12 font-medium text-muted">
                      chat + search
                    </span>
                  )}
                  {!row.isEnabled && (
                    <span className="rounded bg-line/60 px-1.5 py-0.5 text-12 font-medium text-muted">
                      disabled
                    </span>
                  )}
                </div>
                <div className="truncate text-12 text-faint">
                  {row.kinds === "search" ? "search only" : row.model} · {row.baseUrl}
                </div>
                {rowModels[row.id]?.length > 0 && row.kinds !== "search" && (
                  <label className="mt-2 block text-12 text-muted">
                    Model from this provider
                    <select className="input mt-1 w-full" value={row.model}
                      onChange={event => void patch(row.id, { model: event.target.value }, `model-${row.id}`)}>
                      {!rowModels[row.id].includes(row.model) && <option value={row.model}>Choose a listed model…</option>}
                      {rowModels[row.id].map(model => <option key={model} value={model}>{model}</option>)}
                    </select>
                  </label>
                )}
                {row.lastTestMessage && (
                  <div
                    className={`text-12 ${row.lastTestOk ? "text-emerald-600" : "text-rose-600"}`}
                  >
                    {row.lastTestOk ? "Last test OK" : "Last test failed"} — {row.lastTestMessage}
                  </div>
                )}
              </div>

              <label className="flex items-center gap-1 text-12 text-muted">
                Order
                <input
                  className="input w-14 px-1.5 py-0.5 text-12"
                  type="number"
                  min={1}
                  defaultValue={row.priority}
                  onBlur={(event) => void savePriority(row, event.target.value)}
                />
              </label>

              <button
                type="button"
                className="btn"
                onClick={() => void test(row)}
                disabled={pending === `test-${row.id}`}
              >
                {pending === `test-${row.id}` ? (
                  <LoaderCircle size={12} className="spin" />
                ) : (
                  <RefreshCw size={12} />
                )}
                Test
              </button>

              <button type="button" className="btn" onClick={() => void toggle(row)}>
                {row.isEnabled ? <ShieldOff size={12} /> : <ShieldCheck size={12} />}
                {row.isEnabled ? "Disable" : "Enable"}
              </button>

              {canDelete && <button
                type="button"
                className="btn"
                onClick={() => { setDeleting(row); setSwitchTo(""); setError(null); setNotice(null); }}
                aria-label={`Delete ${row.name}`}
              >
                <Trash2 size={12} />
                Delete
              </button>}
            </div>
          ))}
        </div>
      )}

      {adding && (
        <div className="mt-3 space-y-2 rounded-lg border border-line/70 px-2.5 py-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="provider-name">
                Name
              </label>
              <input
                id="provider-name"
                className="input"
                placeholder="Primary gateway"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="provider-slug">
                Provider
              </label>
              <select
                id="provider-slug"
                className="input"
                value={form.provider}
                onChange={(event) => {
                  const choice = PROVIDER_CATALOG[event.target.value];
                  setModels([]);
                  setForm({
                    ...form,
                    provider: event.target.value,
                    model: "",
                    kinds: choice ? choice.kinds : form.kinds,
                  });
                }}
              >
                {Object.entries(PROVIDER_CATALOG).map(([slug, choice]) => (
                  <option key={slug} value={slug}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="provider-kinds">
                Can do
              </label>
              <select
                id="provider-kinds"
                className="input"
                value={form.kinds}
                onChange={(event) => setForm({ ...form, kinds: event.target.value })}
              >
                <option value="chat">Chat only (a model)</option>
                <option value="both">Chat and search</option>
                <option value="search">Search only (no model)</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="provider-key">
                API key
              </label>
              <input
                id="provider-key"
                className="input"
                type="password"
                autoComplete="off"
                value={form.apiKey}
                onChange={(event) => { setModels([]); setForm({ ...form, apiKey: event.target.value, model: "" }); }}
              />
            </div>
            <div>
              <label className="label" htmlFor="provider-base">
                Base URL (optional)
              </label>
              <input
                id="provider-base"
                className="input"
                placeholder="https://api.deepseek.com"
                value={form.baseUrl}
                onChange={(event) => { setModels([]); setForm({ ...form, baseUrl: event.target.value, model: "" }); }}
              />
            </div>
            <div>
              <label className="label" htmlFor="provider-model">
                Model {form.kinds === "search" ? "(not used)" : "(from provider list)"}
              </label>
              <select id="provider-model" className="input" value={form.model}
                disabled={form.kinds === "search" || models.length === 0}
                onChange={event => setForm({ ...form, model: event.target.value })}>
                <option value="">{form.kinds === "search" ? "search-only" : "Load models, then choose…"}</option>
                {models.map(model => <option key={model} value={model}>{model}</option>)}
              </select>
              {form.kinds !== "search" && <button type="button" className="btn mt-2"
                disabled={!form.apiKey.trim() || pending === "models"} onClick={() => void loadModels()}>
                {pending === "models" ? "Loading models…" : "Load models"}
              </button>}
            </div>
            {form.kinds !== "chat" && (
              <>
                <div>
                  <label className="label" htmlFor="provider-search-path">Search path (optional)</label>
                  <input id="provider-search-path" className="input" placeholder="/v1/tools/search"
                    value={form.searchPath} onChange={(event) => setForm({ ...form, searchPath: event.target.value })} />
                </div>
                <div>
                  <label className="label" htmlFor="provider-fetch-path">Fetch path (optional)</label>
                  <input id="provider-fetch-path" className="input" placeholder="/v1/tools/fetch"
                    value={form.fetchPath} onChange={(event) => setForm({ ...form, fetchPath: event.target.value })} />
                </div>
              </>
            )}
          </div>
          <SubmitBar>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void add()}
              disabled={!!pending || (form.kinds !== "search" && !models.includes(form.model))}
            >
              {pending === "add" ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <Plus size={13} />
              )}
              Add to the order
            </button>
          </SubmitBar>
        </div>
      )}

      <InlineError>{error}</InlineError>
      {deleting && (
        <Modal
          open
          onClose={() => { setDeleting(null); setSwitchTo(""); }}
          width="sm"
          title={`Delete ${deleting.name}?`}
          description="Its stored key is destroyed and can't be recovered."
        >
          {(deleting.usedBy ?? []).length > 0 ? (
            <div className="space-y-3" data-delete-in-use>
              <p className="text-13 text-ink">
                These AI actions still point at {deleting.name}:
              </p>
              <ul className="list-disc space-y-1 pl-5 text-12 text-muted">
                {(deleting.usedBy ?? []).map(use => <li key={use}>{use}</li>)}
              </ul>
              {workingOptions.filter(provider => provider.id !== deleting.id).length === 0 ? (
                <p className="rounded-lg bg-rust/10 px-2.5 py-2 text-12 text-rust">
                  No other working provider is available to move them to, so this cannot be deleted
                  yet. Add and test another provider first.
                </p>
              ) : (
                <>
                  <p className="text-12 text-muted">
                    Choose the provider they should use instead. Nothing is left pointing at a
                    provider that cannot answer.
                  </p>
                  <label className="block text-12 text-muted">
                    Switch them to
                    <select
                      className="input mt-1 w-full text-12"
                      aria-label="Switch actions to"
                      value={switchTo}
                      onChange={event => setSwitchTo(event.target.value)}
                    >
                      <option value="">Choose a working provider...</option>
                      {workingOptions
                        .filter(provider => provider.id !== deleting.id)
                        .map(provider => (
                          <option key={provider.id} value={provider.id}>
                            {provider.name} · {provider.model}
                          </option>
                        ))}
                    </select>
                  </label>
                </>
              )}
            </div>
          ) : (
            <p className="text-13 text-ink" data-delete-unused>
              No AI action or fallback list points at {deleting.name}. A record of it (name, type and
              when it was deleted) stays, so older labels still make sense.
            </p>
          )}

          <SubmitBar>
            <button
              type="button"
              className="btn"
              onClick={() => { setDeleting(null); setSwitchTo(""); }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={
                pending === `delete-${deleting.id}` ||
                ((deleting.usedBy ?? []).length > 0 &&
                  (!switchTo || workingOptions.filter(p => p.id !== deleting.id).length === 0))
              }
              onClick={() => void confirmDelete()}
            >
              {pending === `delete-${deleting.id}` && <LoaderCircle size={13} className="spin" />}
              {(deleting.usedBy ?? []).length > 0 ? "Switch and delete" : "Delete provider"}
            </button>
          </SubmitBar>
        </Modal>
      )}
      {notice && <div className="mt-4" data-provider-test-notice><Notice tone={noticeOk ? "success" : "danger"}>{notice}</Notice></div>}
    </div>
  );
}