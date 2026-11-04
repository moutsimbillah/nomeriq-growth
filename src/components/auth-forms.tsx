"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { apiRequest } from "./client-ui";
import { loginTarget } from "@/lib/app-url";

export function LoginForm({ hasUsers, next }: { hasUsers: boolean; next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await apiRequest("/api/auth/login", { body: { email, password } });
      // Only a same-site path is accepted, so this can never bounce to another host.
      router.push(loginTarget(next));
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign in failed.");
    } finally {
      setPending(false);
    }
  }

  if (!hasUsers) {
    return (
      <div className="space-y-4">
        <p className="text-13 leading-6 text-muted">
          This Growth workspace has not been initialized yet.
        </p>
        <a href="/setup" className="btn-primary w-full">
          Initialize the workspace
          <ArrowRight size={15} />
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="label" htmlFor="email">
          Founder email
        </label>
        <input
          id="email"
          type="email"
          className="input h-11"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@nomeriq.com"
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="password">
          Password
        </label>
        <div className="relative">
          <input
            id="password"
            type={show ? "text" : "password"}
            className="input h-11 pr-11"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Your password"
            required
          />
          <button
            type="button"
            onClick={() => setShow((current) => !current)}
            className="absolute right-1 top-1 grid h-9 w-9 place-items-center rounded-lg text-faint hover:bg-ink/[0.04] hover:text-ink"
            aria-label={show ? "Hide password" : "Show password"}
          >
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
      </div>
      {error && (
        <div className="rounded-xl border border-rust/20 bg-rust/[0.05] px-3 py-2.5 text-12 text-rust">
          {error}
        </div>
      )}
      <button type="submit" className="btn-primary h-11 w-full" disabled={pending}>
        {pending ? "Signing in…" : "Enter Growth"}
        {!pending && <ArrowRight size={15} />}
      </button>
    </form>
  );
}

export function SetupForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 10) {
      setError("Use at least 10 characters.");
      return;
    }
    setPending(true);
    try {
      await apiRequest("/api/auth/setup", {
        body: { name, email, password },
      });
      router.push("/dashboard");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Setup failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="setup-name">
            Your name
          </label>
          <input
            id="setup-name"
            className="input h-11"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Founder"
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="setup-email">
            Email
          </label>
          <input
            id="setup-email"
            type="email"
            className="input h-11"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@nomeriq.com"
            required
          />
        </div>
      </div>
      <div>
        <label className="label" htmlFor="setup-password">
          Password
        </label>
        <div className="relative">
          <input
            id="setup-password"
            type={show ? "text" : "password"}
            className="input h-11 pr-11"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="At least 10 characters"
            required
          />
          <button
            type="button"
            onClick={() => setShow((current) => !current)}
            className="absolute right-1 top-1 grid h-9 w-9 place-items-center rounded-lg text-faint hover:bg-ink/[0.04] hover:text-ink"
            aria-label={show ? "Hide password" : "Show password"}
          >
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
      </div>
      <div>
        <label className="label" htmlFor="setup-confirm">
          Confirm password
        </label>
        <input
          id="setup-confirm"
          type="password"
          className="input h-11"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          required
        />
      </div>
      {error && (
        <div className="rounded-xl border border-rust/20 bg-rust/[0.05] px-3 py-2.5 text-12 text-rust">
          {error}
        </div>
      )}
      <button type="submit" className="btn-primary h-11 w-full" disabled={pending}>
        {pending ? "Creating workspace…" : "Create founder account"}
        {!pending && <ArrowRight size={15} />}
      </button>
      <p className="text-center text-12 leading-5 text-faint">
        This creates an independent Growth account. It is not connected to the
        main Nomeriq login.
      </p>
    </form>
  );
}
