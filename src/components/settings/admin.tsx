"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Download,
  KeyRound,
  LoaderCircle,
  Plus,
  ShieldOff,
  UserPlus,
  Users,
} from "lucide-react";
import { apiRequest, InlineError, Modal, SubmitBar } from "../client-ui";
import { Notice } from "../ui";

type UserRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  createdAt: string | null;
  lastLoginAt: string | null;
};

export function TeamManager({ users }: { users: UserRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function add() {
    setPending(true);
    setError(null);
    try {
      await apiRequest("/api/settings/team", {
        body: { name, email, password, role },
      });
      setOpen(false);
      setName("");
      setEmail("");
      setPassword("");
      setNotice("Team member added. Share the temporary password securely.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add user.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[12px] font-bold text-ink">Workspace users</div>
          <p className="text-[10px] text-muted">
            Founder and admin can send and change settings. Members are read-only.
          </p>
        </div>
        <button type="button" className="btn-secondary btn-sm" onClick={() => setOpen(true)}>
          <UserPlus size={12} /> Add user
        </button>
      </div>
      <div className="mt-3 space-y-2">
        {users.map((user) => (
          <div
            key={user.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-white/50 px-3.5 py-2.5"
          >
            <div className="flex items-center gap-2.5">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-forest text-[9px] font-bold text-lime">
                {user.name.slice(0, 2).toUpperCase()}
              </span>
              <div>
                <div className="text-[11px] font-semibold text-ink">{user.name}</div>
                <div className="text-[9.5px] text-faint">{user.email}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="badge capitalize">{user.role}</span>
              <span className="text-[9px] text-faint">
                {user.lastLoginAt
                  ? `last in ${new Date(user.lastLoginAt).toLocaleDateString("en-GB")}`
                  : "never signed in"}
              </span>
            </div>
          </div>
        ))}
      </div>
      {notice && <div className="mt-2"><Notice tone="success">{notice}</Notice></div>}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add a workspace user"
        description="This creates independent Growth credentials. It is not the main Nomeriq login."
        width="md"
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Name</label>
              <input
                className="input"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div>
              <label className="label">Email</label>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="label">Temporary password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 10 characters"
            />
          </div>
          <div>
            <label className="label">Role</label>
            <select
              className="select"
              value={role}
              onChange={(event) => setRole(event.target.value as "admin" | "member")}
            >
              <option value="member">Member — read only</option>
              <option value="admin">Admin — send and configure</option>
            </select>
          </div>
          <InlineError>{error}</InlineError>
          <SubmitBar>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={add}
              disabled={pending || !name || !email || password.length < 10}
            >
              {pending ? <LoaderCircle size={13} className="spin" /> : <Users size={13} />}
              {pending ? "Adding…" : "Add user"}
            </button>
          </SubmitBar>
        </div>
      </Modal>
      <ChangePasswordCard />
    </div>
  );
}

function ChangePasswordCard() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function change() {
    setError(null);
    setNotice(null);
    if (newPassword.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (newPassword.length > 16) {
      setError("Use at most 16 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("The two new passwords do not match.");
      return;
    }
    setPending(true);
    try {
      const data = await apiRequest("/api/settings/password", {
        method: "POST",
        body: { currentPassword, newPassword, confirmPassword },
      });
      const revoked =
        typeof data?.sessionsRevoked === "number" ? data.sessionsRevoked : 0;
      setNotice(
        revoked > 0
          ? `Password changed. Every other device has been signed out. ${revoked} other ${
              revoked === 1 ? "session was" : "sessions were"
            } signed out.`
          : "Password changed. Every other device has been signed out.",
      );
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Could not change password.";
      setError(
        /invalid_password|incorrect/i.test(message)
          ? "Your current password is incorrect."
          : message,
      );
    } finally {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPending(false);
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-line bg-white/50 px-3.5 py-3">
      <div className="text-[12px] font-bold text-ink">Change your password</div>
      <p className="text-[10px] text-muted">
        This changes the password for the account you are signed in with. Every
        other signed-in device will be signed out.
      </p>
      <div className="mt-3 space-y-3">
        <div>
          <label className="label" htmlFor="change-password-current">
            Current password
          </label>
          <input
            id="change-password-current"
            className="input"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="change-password-new">
            New password
          </label>
          <input
            id="change-password-new"
            className="input"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <p className="mt-1 text-[9.5px] text-faint">8 to 16 characters.</p>
        </div>
        <div>
          <label className="label" htmlFor="change-password-confirm">
            Confirm new password
          </label>
          <input
            id="change-password-confirm"
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
          />
        </div>
        <InlineError>{error}</InlineError>
        {notice && <Notice tone="success">{notice}</Notice>}
        <SubmitBar>
          <button
            type="button"
            className="btn-primary"
            onClick={change}
            disabled={pending}
          >
            {pending ? <LoaderCircle size={13} className="spin" /> : <KeyRound size={13} />}
            {pending ? "Changing…" : "Change password"}
          </button>
        </SubmitBar>
      </div>
    </div>
  );
}

type SuppressionRow = {
  id: string;
  email: string;
  reason: string;
  source: string;
  note: string | null;
  active: boolean;
  createdAt: string | null;
};

export function SuppressionManager({
  suppressions,
}: {
  suppressions: SuppressionRow[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState<
    "unsubscribe" | "opt_out" | "bounce" | "complaint" | "manual"
  >("manual");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    setPending(true);
    setError(null);
    try {
      await apiRequest("/api/suppressions", {
        body: { email, reason, note },
      });
      setOpen(false);
      setEmail("");
      setNote("");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not suppress.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[12px] font-bold text-ink">Suppression list</div>
          <p className="text-[10px] text-muted">
            Checked server-side before every send. Opt-outs stop promotional email
            immediately.
          </p>
        </div>
        <button type="button" className="btn-secondary btn-sm" onClick={() => setOpen(true)}>
          <ShieldOff size={12} /> Suppress address
        </button>
      </div>
      <div className="mt-3 max-h-[280px] space-y-1.5 overflow-y-auto scrollbar-thin">
        {suppressions.length === 0 ? (
          <div className="rounded-xl border border-dashed-line border-line px-4 py-5 text-center text-[10.5px] text-muted">
            No suppressed addresses.
          </div>
        ) : (
          suppressions.map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-white/50 px-3 py-2"
            >
              <div>
                <div className="text-[10.5px] font-semibold text-ink">{item.email}</div>
                <div className="text-[9px] text-faint">
                  {item.source} · {item.note || "no note"}
                </div>
              </div>
              <span className="badge border-rust/20 bg-rust/[0.05] capitalize text-rust">
                {item.reason.replace("_", " ")}
              </span>
            </div>
          ))
        )}
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Suppress an email address"
        description="This blocks promotional sends and marks any linked prospect do not contact."
        width="sm"
      >
        <div className="space-y-3">
          <div>
            <label className="label">Email</label>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div>
            <label className="label">Reason</label>
            <select
              className="select"
              value={reason}
              onChange={(event) =>
                setReason(
                  event.target.value as
                    | "unsubscribe"
                    | "opt_out"
                    | "bounce"
                    | "complaint"
                    | "manual",
                )
              }
            >
              <option value="manual">Manual</option>
              <option value="unsubscribe">Unsubscribe</option>
              <option value="opt_out">Opt-out</option>
              <option value="bounce">Bounce</option>
              <option value="complaint">Complaint</option>
            </select>
          </div>
          <div>
            <label className="label">Note</label>
            <input
              className="input"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <InlineError>{error}</InlineError>
          <SubmitBar>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={add}
              disabled={pending || !email}
            >
              {pending ? <LoaderCircle size={13} className="spin" /> : <ShieldOff size={13} />}
              {pending ? "Suppressing…" : "Suppress address"}
            </button>
          </SubmitBar>
        </div>
      </Modal>
    </div>
  );
}

export function BackupPanel() {
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[12px] font-bold text-ink">Data export and retention</div>
          <p className="max-w-xl text-[10px] leading-5 text-muted">
            Download a JSON backup of leads, sources, drafts, revisions,
            conversations, campaigns and suppression records. Credentials, session
            tokens, password hashes and API-key hashes are excluded. PostgreSQL /
            Supabase point-in-time backups remain the recovery baseline.
          </p>
        </div>
        <a href="/api/backup" className="btn-secondary btn-sm" download>
          <Download size={12} /> Download backup
        </a>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {[
          ["Lead retention", "Manual archive + suppression"],
          ["Email retention", "Stored for thread and audit"],
          ["Credential storage", "AES-256-GCM encrypted"],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-line bg-white/50 px-3 py-2.5">
            <div className="text-[9px] font-bold uppercase tracking-[0.1em] text-faint">
              {label}
            </div>
            <div className="mt-0.5 text-[10.5px] text-ink">{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
