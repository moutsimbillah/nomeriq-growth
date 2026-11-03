"use client";

import { useState } from "react";
import { LoaderCircle, Plus, RefreshCw, ShieldCheck, ShieldOff } from "lucide-react";

import { Notice } from "../ui";
import { apiRequest, InlineError, SubmitBar } from "../client-ui";

export interface ProviderRowView {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  priority: number;
  isEnabled: boolean;
  hasKey: boolean;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  lastTestedAt: string | null;
}

/**
 * The ordered list of DeepSeek-compatible providers the research engine tries.
 * Lowest priority number is tried first; the engine only fails when all of them fail.
 */
export function ProvidersCard({ initial }: { initial: ProviderRowView[] }) {
  const [providers, setProviders] = useState<ProviderRowView[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", apiKey: "", baseUrl: "", model: "" });

  async function call(label: string, run: () => Promise<{ providers?: ProviderRowView[] } | null>) {
    setError(null);
    setNotice(null);
    setPending(label);
    try {
      const data = await run();
      if (data?.providers) setProviders(data.providers);
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
          apiKey,
          baseUrl: form.baseUrl.trim() || undefined,
          model: form.model.trim() || undefined,
        },
      }),
    );

    if (data) {
      setNotice(`Added ${name}. Test it to confirm the key works.`);
      setForm({ name: "", apiKey: "", baseUrl: "", model: "" });
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
      const outcome = data as unknown as { ok: boolean; message: string };
      setNotice(`${row.name}: ${outcome.message}`);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-line bg-white/50 px-3.5 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[12px] font-bold text-ink">Provider failover order</div>
          <p className="text-[10px] text-muted">
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

      {providers.length === 0 ? (
        <p className="mt-3 text-[10px] text-faint">
          No ordered provider yet — the engine is using the single DeepSeek credential above.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {providers.map((row) => (
            <div
              key={row.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-line/70 px-2.5 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[11px] font-bold text-ink">
                  {row.name}
                  {!row.isEnabled && (
                    <span className="rounded bg-line/60 px-1.5 py-0.5 text-[9px] font-medium text-muted">
                      disabled
                    </span>
                  )}
                </div>
                <div className="truncate text-[9.5px] text-faint">
                  {row.model} · {row.baseUrl}
                </div>
                {row.lastTestMessage && (
                  <div
                    className={`text-[9.5px] ${row.lastTestOk ? "text-emerald-600" : "text-rose-600"}`}
                  >
                    {row.lastTestOk ? "Last test OK" : "Last test failed"} — {row.lastTestMessage}
                  </div>
                )}
              </div>

              <label className="flex items-center gap-1 text-[9.5px] text-muted">
                Order
                <input
                  className="input w-14 px-1.5 py-0.5 text-[10px]"
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
              <label className="label" htmlFor="provider-key">
                API key
              </label>
              <input
                id="provider-key"
                className="input"
                type="password"
                autoComplete="off"
                value={form.apiKey}
                onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
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
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="provider-model">
                Model (optional)
              </label>
              <input
                id="provider-model"
                className="input"
                placeholder="deepseek-flash"
                value={form.model}
                onChange={(event) => setForm({ ...form, model: event.target.value })}
              />
            </div>
          </div>
          <SubmitBar>
            <button
              type="button"
              className="btn-primary"
              onClick={() => void add()}
              disabled={pending === "add"}
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
      {notice && <Notice tone="success">{notice}</Notice>}
    </div>
  );
}