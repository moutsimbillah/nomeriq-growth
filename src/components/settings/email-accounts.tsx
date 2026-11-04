"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  ChevronDown,
  Inbox,
  LoaderCircle,
  Mail,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Star,
  Trash2,
  Wifi,
} from "lucide-react";
import type { PublicEmailAccount } from "@/lib/email/accounts";
import { apiRequest, InlineError, Modal, SubmitBar } from "../client-ui";
import { Notice } from "../ui";

type Usage = {
  sentLast24h: number;
  dailyLimit: number;
  minIntervalSeconds: number;
  nextAllowedAt: string | null;
};

type Health = {
  folder: string;
  lastUid: number;
  lastSyncedAt: string | null;
  historyComplete: boolean;
  error: string | null;
};

type FormState = {
  name: string;
  provider: "ionos" | "smtp_imap" | "sandbox";
  emailAddress: string;
  fromName: string;
  replyTo: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  username: string;
  password: string;
  dailySendLimit: number;
  minIntervalSeconds: number;
  isDefault: boolean;
};

const EMPTY_FORM: FormState = {
  name: "IONOS mailbox",
  provider: "ionos",
  emailAddress: "",
  fromName: "Founder",
  replyTo: "",
  smtpHost: "smtp.ionos.com",
  smtpPort: 587,
  smtpSecure: false,
  imapHost: "imap.ionos.com",
  imapPort: 993,
  imapSecure: true,
  username: "",
  password: "",
  dailySendLimit: 25,
  minIntervalSeconds: 60,
  isDefault: false,
};

function formFromAccount(account: PublicEmailAccount): FormState {
  return {
    name: account.name,
    provider: account.provider,
    emailAddress: account.emailAddress,
    fromName: account.fromName,
    replyTo: account.replyTo || "",
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    smtpSecure: account.smtpSecure,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    imapSecure: account.imapSecure,
    username: "",
    password: "",
    dailySendLimit: account.dailySendLimit,
    minIntervalSeconds: account.minIntervalSeconds,
    isDefault: account.isDefault,
  };
}

export function EmailAccountsManager({
  accounts,
  usages,
  health,
  sendMode,
}: {
  accounts: PublicEmailAccount[];
  usages: Record<string, Usage>;
  health: Record<string, Health[]>;
  sendMode: "sandbox" | "live";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<PublicEmailAccount | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setError(null);
    setMessage(null);
    setOpen(true);
  }

  function openEdit(account: PublicEmailAccount) {
    setEditing(account);
    setForm(formFromAccount(account));
    setError(null);
    setMessage(null);
    setOpen(true);
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function providerChanged(provider: FormState["provider"]) {
    if (provider === "ionos") {
      setForm((current) => ({
        ...current,
        provider,
        smtpHost: "smtp.ionos.com",
        smtpPort: 587,
        smtpSecure: false,
        imapHost: "imap.ionos.com",
        imapPort: 993,
        imapSecure: true,
      }));
    } else if (provider === "sandbox") {
      setForm((current) => ({
        ...current,
        provider,
        name: current.name || "Sandbox test mailbox",
        emailAddress: current.emailAddress || "sandbox@nomeriq.test",
        smtpHost: "",
        imapHost: "",
        username: "",
        password: "",
      }));
    } else {
      setForm((current) => ({ ...current, provider }));
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setPending("save");
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        name: form.name,
        emailAddress: form.emailAddress,
        fromName: form.fromName,
        replyTo: form.replyTo || null,
        smtpHost: form.smtpHost,
        smtpPort: Number(form.smtpPort),
        smtpSecure: form.smtpSecure,
        imapHost: form.imapHost,
        imapPort: Number(form.imapPort),
        imapSecure: form.imapSecure,
        ...(form.username
          ? { username: form.username }
          : !editing
            ? { username: form.emailAddress }
            : {}),
        dailySendLimit: Number(form.dailySendLimit),
        minIntervalSeconds: Number(form.minIntervalSeconds),
        isDefault: form.isDefault,
      };
      if (form.password) payload.password = form.password;
      if (!editing) {
        payload.provider = form.provider;
        if (form.provider === "sandbox") {
          payload.password = crypto.randomUUID();
        } else if (!form.password) {
          throw new Error("Enter the mailbox password or app password.");
        }
      }
      if (editing) {
        await apiRequest(`/api/email/accounts/${editing.id}`, {
          method: "PATCH",
          body: payload,
        });
      } else {
        await apiRequest("/api/email/accounts", { body: payload });
      }
      setOpen(false);
      setMessage(
        editing
          ? "Mailbox settings saved."
          : "Mailbox saved. Growth tested SMTP and IMAP and recorded the result below.",
      );
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save mailbox.");
    } finally {
      setPending(null);
    }
  }

  async function action(id: string, path: string, label: string) {
    setPending(`${id}:${label}`);
    setError(null);
    setMessage(null);
    try {
      const result = await apiRequest(`/api/email/accounts/${id}/${path}`, {
        method: "POST",
      });
      if (label === "verify") {
        setMessage(
          result.error ||
            `Connection healthy. SMTP: ${result.smtp ? "yes" : "no"}; IMAP: ${result.imap ? "yes" : "no"}.`,
        );
      } else if (label === "sync") {
        setMessage(
          result.sandbox
            ? result.note
            : `Sync finished: ${result.imported} imported, ${result.skipped} skipped.`,
        );
      } else {
        setMessage("Default mailbox updated.");
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Action failed.");
    } finally {
      setPending(null);
    }
  }

  async function disable(id: string) {
    if (
      !window.confirm(
        "Disable this mailbox? Historical threads remain, but it cannot send or sync.",
      )
    )
      return;
    setPending(`${id}:disable`);
    setError(null);
    try {
      await apiRequest(`/api/email/accounts/${id}`, { method: "DELETE" });
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not disable.");
    } finally {
      setPending(null);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-12 font-bold uppercase tracking-[0.14em] text-faint">
            {sendMode === "live" ? "Live sending is enabled" : "Sandbox sending"}
          </div>
          <p className="mt-1 max-w-xl text-12 leading-5 text-muted">
            Connect the founder mailbox once. Credentials are encrypted with
            AES-256-GCM. SMTP is used only when the founder sends; IMAP is read
            for replies and external Sent mail.
          </p>
        </div>
        <button type="button" className="btn-secondary btn-sm" onClick={openCreate}>
          <Plus size={12} /> Add mailbox
        </button>
      </div>

      <div className="mt-4 space-y-3">
        {accounts.length === 0 && (
          <div className="rounded-xl border border-dashed-line border-line px-4 py-6 text-center">
            <Mail size={18} className="mx-auto text-faint" />
            <div className="mt-2 text-12 font-semibold text-ink">
              No mailbox connected
            </div>
            <p className="mt-1 text-12 text-muted">
              Add an IONOS mailbox or use the sandbox mailbox for safe testing.
            </p>
          </div>
        )}
        {accounts.map((account) => {
          const usage = usages[account.id];
          const healthRows = health[account.id] || [];
          return (
            <div
              key={account.id}
              className="rounded-xl border border-line bg-white/50 p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="grid h-9 w-9 place-items-center rounded-full bg-forest/[0.06] text-forest">
                    {account.provider === "sandbox" ? (
                      <Inbox size={15} />
                    ) : (
                      <Mail size={15} />
                    )}
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-12 font-bold text-ink">
                        {account.emailAddress}
                      </span>
                      {account.isDefault && (
                        <span className="badge border-forest/20 bg-lime/25 text-forest">
                          <Star size={8} /> default
                        </span>
                      )}
                      <span
                        className={`badge ${
                          account.status === "connected"
                            ? "border-forest/20 bg-lime/20 text-forest"
                            : account.status === "error"
                              ? "border-rust/20 bg-rust/[0.05] text-rust"
                              : ""
                        }`}
                      >
                        {account.status}
                      </span>
                      <span className="badge capitalize">
                        {account.provider === "sandbox"
                          ? "sandbox"
                          : account.provider === "ionos"
                            ? "IONOS"
                            : "SMTP + IMAP"}
                      </span>
                    </div>
                    <div className="mt-0.5 text-12 text-faint">
                      {account.fromName} · {account.name}
                      {account.provider !== "sandbox" &&
                        ` · ${account.smtpHost}:${account.smtpPort} / ${account.imapHost}:${account.imapPort}`}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-ghost btn-xs"
                  onClick={() => openEdit(account)}
                >
                  Edit
                </button>
              </div>

              {account.lastError && (
                <div className="mt-3 rounded-lg border border-rust/20 bg-rust/[0.04] px-2.5 py-2 text-12 leading-4 text-rust">
                  {account.lastError}
                </div>
              )}

              <div className="mt-3 grid gap-2 border-t border-line/80 pt-3 sm:grid-cols-3">
                <div>
                  <div className="text-12 font-bold uppercase tracking-[0.1em] text-faint">
                    Configured safety cap
                  </div>
                  <div className="mt-0.5 text-12 text-muted">
                    {usage?.sentLast24h ?? 0} / {account.dailySendLimit} in rolling
                    24h
                  </div>
                </div>
                <div>
                  <div className="text-12 font-bold uppercase tracking-[0.1em] text-faint">
                    Minimum interval
                  </div>
                  <div className="mt-0.5 text-12 text-muted">
                    {account.minIntervalSeconds}s between sends
                  </div>
                </div>
                <div>
                  <div className="text-12 font-bold uppercase tracking-[0.1em] text-faint">
                    Last sync
                  </div>
                  <div className="mt-0.5 text-12 text-muted">
                    {account.lastSyncAt
                      ? new Date(account.lastSyncAt).toLocaleString("en-GB")
                      : "Never"}
                  </div>
                </div>
              </div>

              {healthRows.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {healthRows.map((row) => (
                    <span
                      key={row.folder}
                      className={`badge ${
                        row.error
                          ? "border-rust/20 bg-rust/[0.05] text-rust"
                          : row.historyComplete
                            ? ""
                            : "border-amber/20 bg-amber/[0.05] text-amber"
                      }`}
                    >
                      {row.folder}: {row.error ? "error" : row.historyComplete ? "complete" : "partial history"}
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-line/80 pt-3">
                {account.provider !== "sandbox" && (
                  <>
                    <button
                      type="button"
                      className="btn-secondary btn-xs"
                      onClick={() => action(account.id, "verify", "verify")}
                      disabled={pending === `${account.id}:verify`}
                    >
                      {pending === `${account.id}:verify` ? (
                        <LoaderCircle size={10} className="spin" />
                      ) : (
                        <Wifi size={10} />
                      )}
                      Test connection
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-xs"
                      onClick={() => action(account.id, "sync", "sync")}
                      disabled={pending === `${account.id}:sync`}
                    >
                      {pending === `${account.id}:sync` ? (
                        <LoaderCircle size={10} className="spin" />
                      ) : (
                        <RefreshCw size={10} />
                      )}
                      Sync now
                    </button>
                  </>
                )}
                {!account.isDefault && (
                  <button
                    type="button"
                    className="btn-ghost btn-xs"
                    onClick={() => action(account.id, "default", "default")}
                    disabled={pending === `${account.id}:default`}
                  >
                    <Star size={10} /> Make default
                  </button>
                )}
                {accounts.length > 1 && (
                  <button
                    type="button"
                    className="btn-ghost btn-xs ml-auto text-faint hover:text-rust"
                    onClick={() => disable(account.id)}
                    disabled={pending === `${account.id}:disable`}
                  >
                    <Trash2 size={10} /> Disable
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {message && (
        <div className="mt-3">
          <Notice tone="success">{message}</Notice>
        </div>
      )}
      {error && (
        <div className="mt-3">
          <InlineError>{error}</InlineError>
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? "Edit mailbox" : "Connect a mailbox"}
        description="Credentials are encrypted at rest. IONOS uses smtp.ionos.com:587 with STARTTLS and imap.ionos.com:993 with TLS."
        width="lg"
      >
        <form onSubmit={save} className="space-y-4">
          {!editing && (
            <div className="grid grid-cols-3 gap-1.5 rounded-xl border border-line bg-paper/50 p-1">
              {[
                { value: "ionos", label: "IONOS", icon: Mail },
                { value: "smtp_imap", label: "Other SMTP/IMAP", icon: Server },
                { value: "sandbox", label: "Sandbox", icon: ShieldCheck },
              ].map((provider) => (
                <button
                  type="button"
                  key={provider.value}
                  onClick={() =>
                    providerChanged(provider.value as FormState["provider"])
                  }
                  className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-12 font-semibold transition ${
                    form.provider === provider.value
                      ? "bg-white text-ink shadow-sm"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  <provider.icon size={12} />
                  {provider.label}
                </button>
              ))}
            </div>
          )}

          {form.provider === "sandbox" ? (
            <Notice tone="sandbox">
              A sandbox mailbox never connects to SMTP or IMAP. It records test
              sends and accepts simulated replies only. Use it to demonstrate the
              full workflow safely.
            </Notice>
          ) : (
            <Notice tone="info">
              Use the mailbox password or an app password if IONOS requires one.
              Growth verifies both SMTP and IMAP once on save and shows the exact
              failure if either is unhealthy.
            </Notice>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Email address</label>
              <input
                className="input"
                type="email"
                value={form.emailAddress}
                onChange={(event) => update("emailAddress", event.target.value)}
                required
              />
            </div>
            <div>
              <label className="label">From name</label>
              <input
                className="input"
                value={form.fromName}
                onChange={(event) => update("fromName", event.target.value)}
                required
              />
            </div>
            <div>
              <label className="label">Label</label>
              <input
                className="input"
                value={form.name}
                onChange={(event) => update("name", event.target.value)}
              />
            </div>
            <div>
              <label className="label">Reply-to (optional)</label>
              <input
                className="input"
                type="email"
                value={form.replyTo}
                onChange={(event) => update("replyTo", event.target.value)}
              />
            </div>
          </div>

          {form.provider !== "sandbox" && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label">Username</label>
                  <input
                    className="input"
                    value={form.username}
                    onChange={(event) => update("username", event.target.value)}
                    placeholder={form.emailAddress || "Mailbox username"}
                  />
                </div>
                <div>
                  <label className="label">
                    Password {editing && "(leave blank to keep current)"}
                  </label>
                  <input
                    className="input"
                    type="password"
                    value={form.password}
                    onChange={(event) => update("password", event.target.value)}
                    required={!editing}
                    autoComplete="new-password"
                  />
                </div>
              </div>

              <details className="group rounded-xl border border-line bg-paper/40 px-3.5 py-3">
                <summary className="flex cursor-pointer list-none items-center justify-between text-12 font-semibold text-muted">
                  SMTP / IMAP server settings
                  <ChevronDown size={13} className="transition group-open:rotate-180" />
                </summary>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="label">SMTP host</label>
                    <input
                      className="input"
                      value={form.smtpHost}
                      onChange={(event) => update("smtpHost", event.target.value)}
                    />
                  </div>
                  <div>
                    <label className="label">SMTP port</label>
                    <input
                      className="input"
                      type="number"
                      value={form.smtpPort}
                      onChange={(event) => update("smtpPort", Number(event.target.value))}
                    />
                  </div>
                  <div>
                    <label className="label">IMAP host</label>
                    <input
                      className="input"
                      value={form.imapHost}
                      onChange={(event) => update("imapHost", event.target.value)}
                    />
                  </div>
                  <div>
                    <label className="label">IMAP port</label>
                    <input
                      className="input"
                      type="number"
                      value={form.imapPort}
                      onChange={(event) => update("imapPort", Number(event.target.value))}
                    />
                  </div>
                  <label className="flex items-center gap-2 text-12 text-muted">
                    <input
                      type="checkbox"
                      checked={form.smtpSecure}
                      onChange={(event) => update("smtpSecure", event.target.checked)}
                    />
                    SMTP implicit TLS (port 465)
                  </label>
                  <label className="flex items-center gap-2 text-12 text-muted">
                    <input
                      type="checkbox"
                      checked={form.imapSecure}
                      onChange={(event) => update("imapSecure", event.target.checked)}
                    />
                    IMAP implicit TLS
                  </label>
                </div>
              </details>
            </>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Configured daily cap</label>
              <input
                className="input"
                type="number"
                min={1}
                max={500}
                value={form.dailySendLimit}
                onChange={(event) => update("dailySendLimit", Number(event.target.value))}
              />
              <p className="field-hint">
                This is your app safety cap, not a claim about IONOS limits.
              </p>
            </div>
            <div>
              <label className="label">Minimum seconds between sends</label>
              <input
                className="input"
                type="number"
                min={5}
                max={3600}
                value={form.minIntervalSeconds}
                onChange={(event) =>
                  update("minIntervalSeconds", Number(event.target.value))
                }
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-12 text-muted">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(event) => update("isDefault", event.target.checked)}
            />
            Use this mailbox by default for sending and syncing
          </label>

          <InlineError>{error}</InlineError>
          <SubmitBar>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={!!pending}>
              {pending === "save" ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <CheckCircle2 size={13} />
              )}
              {pending === "save"
                ? "Testing connection…"
                : editing
                  ? "Save mailbox"
                  : form.provider === "sandbox"
                    ? "Create sandbox mailbox"
                    : "Connect and verify"}
            </button>
          </SubmitBar>
        </form>
      </Modal>
    </div>
  );
}
