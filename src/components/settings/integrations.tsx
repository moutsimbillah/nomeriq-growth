"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bot,
  Check,
  Download,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { CopyButton, apiRequest, InlineError, Modal, SubmitBar } from "../client-ui";
import { Notice } from "../ui";
import { DEFAULT_SCOPES } from "@/lib/agent/scopes";
import { formatDate } from "@/lib/utils";

const SCOPES = [
  ["research:read", "Search leads, jobs and duplicate checks"],
  ["research:write", "Save verified prospects and evidence"],
  ["drafts:write", "Save personalized drafts for founder review"],
  ["product_truth:read", "Read approved Product Truth"],
  ["conversations:read", "Read conversation context and suggest replies"],
  ["progress:read", "Read database-derived research progress"],
] as const;

const EXPIRY_OPTIONS = [30, 90, 180, 365] as const;

const DAY_MS = 86_400_000;

/** Whole days until expiry, negative when already expired, null when no date. */
function daysUntil(value: string | null): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return Math.ceil((time - Date.now()) / DAY_MS);
}

type ApiKeyRow = {
  id: string;
  name: string;
  assistant: string;
  prefix: string;
  scopes: string[];
  creatorName: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
};

export function IntegrationsManager({
  keys,
  appUrl,
  aiProvider,
  hasOpenAI,
  hasAnthropic,
}: {
  keys: ApiKeyRow[];
  appUrl: string;
  aiProvider: string;
  hasOpenAI: boolean;
  hasAnthropic: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [assistant, setAssistant] = useState<
    "chatgpt" | "claude" | "deepseek" | "hermes" | "custom"
  >("claude");
  const [scopes, setScopes] = useState<string[]>([...DEFAULT_SCOPES]);
  const [expiresInDays, setExpiresInDays] = useState(90);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createdKey, setCreatedKey] = useState<string | null>(null);

  async function create() {
    setPending("create");
    setError(null);
    try {
      const result = await apiRequest("/api/api-keys", {
        body: { name, assistant, scopes, expiresInDays },
      });
      setOpen(false);
      setCreatedKey(result.key);
      setName("");
      setScopes([...DEFAULT_SCOPES]);
      setExpiresInDays(90);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create key.");
    } finally {
      setPending(null);
    }
  }

  async function revoke(id: string) {
    if (
      !window.confirm(
        "Revoke this key immediately? Any assistant using it will stop working.",
      )
    )
      return;
    setPending(id);
    setError(null);
    try {
      await apiRequest(`/api/api-keys/${id}`, { method: "DELETE" });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not revoke.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-line bg-white/50 p-4">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.12em] text-faint">
            <Bot size={12} /> AI drafting
          </div>
          <div className="mt-2 flex items-center gap-2">
            <span className="text-[12px] font-semibold capitalize text-ink">
              {aiProvider === "none" ? "Deterministic writer" : aiProvider}
            </span>
            <span
              className={`badge ${
                hasOpenAI || hasAnthropic
                  ? "border-forest/20 bg-lime/20 text-forest"
                  : "border-amber/20 bg-amber/[0.06] text-amber"
              }`}
            >
              {hasOpenAI || hasAnthropic ? "configured" : "optional, no key"}
            </span>
          </div>
          <p className="mt-2 text-[10px] leading-5 text-muted">
            Without an AI key, Growth uses its deterministic founder-style writer.
            Drafts still work, still get claim warnings, and never auto-send.
          </p>
        </div>
        <div className="rounded-xl border border-line bg-white/50 p-4">
          <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.12em] text-faint">
            <LockKeyhole size={12} /> Assistant boundary
          </div>
          <p className="mt-2 text-[10px] leading-5 text-muted">
            API keys cannot send email, delete records, change Product Truth,
            alter settings or bypass suppression. There is no send scope to
            grant.
          </p>
        </div>
      </div>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[12px] font-bold text-ink">API keys</div>
            <p className="text-[10px] text-muted">
              Create one key per assistant or environment. Shown once, stored
              hashed.
            </p>
          </div>
          <button type="button" className="btn-secondary btn-sm" onClick={() => setOpen(true)}>
            <Plus size={12} /> Create key
          </button>
        </div>

        <div className="mt-3 space-y-2">
          {keys.length === 0 && (
            <div className="rounded-xl border border-dashed-line border-line px-4 py-5 text-center text-[10.5px] text-muted">
              No keys yet. Create one for Claude, one for ChatGPT, or a separate
              key for the REST API.
            </div>
          )}
          {keys.map((key) => {
            const days = daysUntil(key.expiresAt);
            const expired = days !== null && days <= 0;
            const expiringSoon = days !== null && days > 0 && days <= 14;
            return (
              <div
                key={key.id}
                className={`flex flex-wrap items-start justify-between gap-3 rounded-xl border p-3.5 ${
                  key.revokedAt
                    ? "border-line bg-paper/30 opacity-60"
                    : "border-line bg-white/50"
                }`}
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <KeyRound size={12} className="text-faint" />
                    <span className="text-[11.5px] font-semibold text-ink">
                      {key.name}
                    </span>
                    <span className="badge capitalize">{key.assistant}</span>
                    {key.revokedAt ? (
                      <span className="badge border-rust/20 bg-rust/[0.05] text-rust">
                        revoked
                      </span>
                    ) : expired ? (
                      <span className="badge border-rust/20 bg-rust/[0.05] text-rust">
                        expired
                      </span>
                    ) : (
                      <span className="badge border-forest/20 bg-lime/20 text-forest">
                        active
                      </span>
                    )}
                  </div>
                  <div className="mt-1 font-mono text-[9.5px] text-faint">
                    {key.prefix}••••••••
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {key.scopes.map((scope) => (
                      <span key={scope} className="badge">
                        {scope}
                      </span>
                    ))}
                  </div>
                  <div className="mt-1 text-[9px] text-faint">
                    Created {key.createdAt ? new Date(key.createdAt).toLocaleDateString("en-GB") : "unknown"}
                    {key.lastUsedAt
                      ? ` · last used ${new Date(key.lastUsedAt).toLocaleString("en-GB")}`
                      : " · never used"}
                  </div>
                  {!key.revokedAt && key.expiresAt && (
                    <div
                      className={`mt-1 text-[9px] ${
                        expired
                          ? "font-semibold text-rust"
                          : expiringSoon
                            ? "font-semibold text-amber"
                            : "text-faint"
                      }`}
                    >
                      {expired
                        ? `Expired ${formatDate(key.expiresAt)}`
                        : `Expires ${formatDate(key.expiresAt)}${
                            days === null ? "" : ` (in ${days} ${days === 1 ? "day" : "days"})`
                          }`}
                    </div>
                  )}
                  {!key.revokedAt && expiringSoon && (
                    <div className="mt-2">
                      <Notice tone="warning" title="Expires soon.">
                        This key expires in {days} {days === 1 ? "day" : "days"}. Rotate
                        it now: create a replacement, update the assistant, then
                        revoke this key.
                      </Notice>
                    </div>
                  )}
                </div>
                {!key.revokedAt && (
                  <button
                    type="button"
                    className="btn-ghost btn-xs text-faint hover:text-rust"
                    onClick={() => revoke(key.id)}
                    disabled={pending === key.id}
                  >
                    {pending === key.id ? (
                      <LoaderCircle size={10} className="spin" />
                    ) : (
                      <Trash2 size={10} />
                    )}
                    Revoke
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {error && <div className="mt-2"><InlineError>{error}</InlineError></div>}
      </div>

      <div className="rounded-xl border border-line bg-paper/40 p-4">
        <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-faint">
          Connection endpoints
        </div>
        <div className="mt-3 space-y-2.5">
          {[
            ["MCP endpoint", `${appUrl}/api/mcp`],
            ["REST API base", `${appUrl}/api/agent/v1`],
            ["OpenAPI schema (ChatGPT Action)", `${appUrl}/api/agent/openapi`],
          ].map(([label, value]) => (
            <div key={label}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[9.5px] font-semibold text-muted">{label}</span>
                <CopyButton value={value} label="Copy" className="btn-ghost btn-xs" />
              </div>
              <div className="mt-1 overflow-x-auto rounded-lg border border-line bg-white/70 px-2.5 py-2 font-mono text-[9.5px] text-ink scrollbar-thin">
                {value}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-line bg-white/60 p-3">
            <div className="text-[10px] font-bold text-ink">Claude</div>
            <p className="mt-1 text-[9.5px] leading-4 text-muted">
              Add a custom connector using the MCP URL above. Set the
              Authorization header to <code>Bearer &lt;key&gt;</code>. Call{" "}
              <code>get_instructions</code> first.
            </p>
          </div>
          <div className="rounded-lg border border-line bg-white/60 p-3">
            <div className="text-[10px] font-bold text-ink">ChatGPT</div>
            <p className="mt-1 text-[9.5px] leading-4 text-muted">
              Create a Custom GPT Action by importing the OpenAPI schema, then use
              bearer authentication with a Growth key. The same skill is available
              through <code>get_instructions</code>.
            </p>
          </div>
        </div>
        <div className="mt-3 rounded-lg border border-line bg-white/60 p-3">
          <div className="flex items-center gap-2">
            <Download size={12} className="text-muted" />
            <div className="text-[10px] font-bold text-ink">Assistant skill</div>
          </div>
          <p className="mt-1 text-[9.5px] leading-4 text-muted">
            A skill file with YAML frontmatter, downloaded as <code>SKILL.md</code>. The loader
            carries no research rules — it tells the assistant to read them from Growth on every
            session — so it never goes stale; upload it once. The full copy is a dated snapshot for
            reference.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <a href="/api/assistant-skill?format=loader" className="btn-ghost btn-xs">
              <Download size={10} /> Loader (recommended)
            </a>
            <a href="/api/assistant-skill?format=full" className="btn-ghost btn-xs">
              <Download size={10} /> Full copy
            </a>
          </div>
          <p className="mt-2 text-[9px] leading-4 text-faint">
            If you also use the older nomeriq-growth skill, turn it off, or the assistant may follow
            the old portal&apos;s tool names.
          </p>
        </div>

        <div className="mt-3 flex items-center gap-2 text-[9px] text-faint">
          <ShieldCheck size={10} />
          Both assistants read and write the same PostgreSQL records. No second
          prospect database.
        </div>
      </div>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Create an assistant API key"
        description="The key is shown once. Store it in the assistant's secure credential field."
        width="md"
      >
        <div className="space-y-4">
          <div>
            <label className="label">Key name</label>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Claude research — laptop"
            />
          </div>
          <div>
            <label className="label">Assistant</label>
            <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-line bg-paper/50 p-1">
              {(["claude", "chatgpt", "deepseek", "hermes", "custom"] as const).map(
                (value) => (
                  <button
                    type="button"
                    key={value}
                    onClick={() => setAssistant(value)}
                    className={`rounded-lg px-2 py-2 text-[10.5px] font-semibold capitalize transition ${
                      assistant === value
                        ? "bg-white text-ink shadow-sm"
                        : "text-muted hover:text-ink"
                    }`}
                  >
                    {value}
                  </button>
                ),
              )}
            </div>
          </div>
          <div>
            <label className="label">Expires in</label>
            <select
              className="select"
              value={expiresInDays}
              onChange={(event) => setExpiresInDays(Number(event.target.value))}
            >
              {EXPIRY_OPTIONS.map((days) => (
                <option key={days} value={days}>
                  {days} days
                </option>
              ))}
            </select>
            <p className="mt-1 text-[9.5px] text-muted">
              The key stops working after this date. Create a replacement before it
              expires and revoke the old key.
            </p>
          </div>
          <div>
            <label className="label">Permissions</label>
            <div className="space-y-1.5">
              {SCOPES.map(([scope, label]) => (
                <label
                  key={scope}
                  className="flex items-start gap-2 rounded-lg border border-line bg-white/50 px-2.5 py-2 text-[10px] text-muted"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={scopes.includes(scope)}
                    onChange={(event) =>
                      setScopes((current) =>
                        event.target.checked
                          ? [...current, scope]
                          : current.filter((item) => item !== scope),
                      )
                    }
                  />
                  <span>
                    <span className="font-semibold text-ink">{scope}</span>
                    <br />
                    {label}
                  </span>
                </label>
              ))}
            </div>
          </div>
          <InlineError>{error}</InlineError>
          <SubmitBar>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={create}
              disabled={pending === "create" || !name.trim() || scopes.length === 0}
            >
              {pending === "create" ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <KeyRound size={13} />
              )}
              {pending === "create" ? "Creating…" : "Create key"}
            </button>
          </SubmitBar>
        </div>
      </Modal>

      <Modal
        open={!!createdKey}
        onClose={() => setCreatedKey(null)}
        title="Copy this key now"
        description="For security, Growth stores only a hash and cannot show it again."
        width="md"
      >
        <div className="rounded-xl border border-forest/20 bg-lime/10 p-4">
          <div className="break-all font-mono text-[11px] leading-5 text-forest">
            {createdKey}
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <CopyButton value={createdKey || ""} label="Copy API key" />
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={() => setCreatedKey(null)}
          >
            <Check size={12} /> I have stored it
          </button>
        </div>
      </Modal>
    </div>
  );
}
