import crypto from "node:crypto";
import { NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/auth/request";
import { DEFAULT_SCOPES, type ApiScope } from "@/lib/agent/scopes";
import { loginRedirectUrl, publicOrigin } from "@/lib/app-url";
import {
  AUTH_CODE_TTL_SECONDS,
  clientAllowsRedirect,
  createAuthorizationCode,
  getOAuthClient,
  scopesFromRequest,
} from "@/lib/oauth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DESCRIPTIONS: Record<ApiScope, string> = {
  "research:read": "Read research, leads and the research ledger",
  "research:write": "Save research and leads, and record searches in the research ledger",
  "drafts:write": "Save outreach drafts for founder review (not approve, queue or send)",
  "product_truth:read": "Read Product Truth",
  "progress:read": "Read research progress",
  "conversations:read": "Read prospect email conversations, including message content",
  "folders:read": "Read email folder names and counts only (not message content)",
  "followups:read": "Read follow-ups due (listing lead or conversation details also requires conversations:read)",
  "followups:write": "Save follow-up drafts for founder review (also requires conversations:read; never approve, queue or send)",
};

const CONSENT_FIELDS = [
  "client_id", "redirect_uri", "state", "scope", "code_challenge", "code_challenge_method",
] as const;

// One-time, user-bound tickets bind POST to exactly what GET displayed, including
// redirects, PKCE and scopes, and prevent CSRF. Per-process: restart => reopen consent.
const pendingConsents = new Map<string, { userId: string; expiresAt: number; fields: string[] }>();
const MAX_PENDING_CONSENTS = 1000;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

/**
 * The consent step. A hosted connector sends the founder here; if they are signed in they
 * see one page naming the connector and what it may do, and approving mints a short-lived
 * authorization code. Nothing is granted without that explicit press.
 */
function page(title: string, body: string, status = 200): NextResponse {
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Nomeriq Growth</title>
<style>
:root{color-scheme:light}
body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;background:#f6f7f9;margin:0;padding:48px 16px;color:#111}
.card{max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:28px}
h1{font-size:18px;margin:0 0 6px}
p{font-size:13px;line-height:1.6;color:#4b5563}
ul{font-size:13px;color:#4b5563;line-height:1.8;padding-left:18px}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:12px}
button{font:inherit;font-size:13px;font-weight:600;padding:9px 16px;border-radius:8px;border:1px solid #111;background:#111;color:#fff;cursor:pointer}
button.secondary{background:#fff;color:#111;border-color:#d1d5db}
.row{display:flex;gap:8px;margin-top:18px}
</style></head><body><div class="card">${body}</div></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'none'",
        "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
      },
    },
  );
}

function errorPage(message: string, status = 400) {
  return page("Request refused", `<h1>Request refused</h1><p>${escapeHtml(message)}</p>`, status);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const responseType = url.searchParams.get("response_type");
  if (responseType && responseType !== "code") return errorPage("Only response_type=code is supported.");

  if (!clientId || !redirectUri) return errorPage("client_id and redirect_uri are required.");

  const client = await getOAuthClient(clientId);
  if (!client) return errorPage("This connector is not registered with Growth.");
  if (!(await clientAllowsRedirect(clientId, redirectUri))) {
    return errorPage("That redirect_uri is not registered for this connector.");
  }

  const user = await getSessionUser();
  if (!user) {
    // Built from APP_URL so the founder is asked to sign in on the public origin.
    return NextResponse.redirect(loginRedirectUrl(url.pathname + url.search, request));
  }

  let requested: string[];
  try {
    requested = scopesFromRequest(url.searchParams.get("scope"));
  } catch {
    return errorPage("Unsupported scope requested.");
  }
  const values = CONSENT_FIELDS.map((name) =>
    name === "scope" ? requested.join(" ") : url.searchParams.get(name) ?? "",
  );
  const now = Date.now();
  for (const [ticket, consent] of pendingConsents) {
    if (consent.expiresAt <= now) pendingConsents.delete(ticket);
  }
  if (pendingConsents.size >= MAX_PENDING_CONSENTS) {
    return errorPage("Too many pending consent requests. Try again later.", 429);
  }
  const ticket = crypto.randomUUID();
  pendingConsents.set(ticket, {
    userId: user.id, expiresAt: now + AUTH_CODE_TTL_SECONDS * 1000, fields: values,
  });
  const fields = CONSENT_FIELDS.map((name, index) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(values[index])}">`,
  ).join("") + `<input type="hidden" name="consent_ticket" value="${ticket}">`;
  const optional = requested.filter((scope) => !(DEFAULT_SCOPES as readonly string[]).includes(scope));
  const standard = requested.filter((scope) => !optional.includes(scope));
  const describe = (scope: string) => `${DESCRIPTIONS[scope as ApiScope]} <code>${scope}</code>`;

  return page(
    "Authorize connector",
    `<h1>Authorize “${escapeHtml(client.client_name)}”</h1>
     <p>This connector is requesting Growth permissions as <strong>${escapeHtml(user.email)}</strong>.</p>
     <form method="post" action="/api/oauth/authorize">${fields}
       ${standard.length ? `<p>Approving grants these requested research permissions:</p><ul>${standard.map((scope) => `<li>${describe(scope)}</li>`).join("")}</ul>` : ""}
       ${optional.length ? `<p>Email permissions are optional and off by default. Select only those you approve:</p><ul>${optional.map((scope) => `<li><label><input type="checkbox" name="approved_scope" value="${scope}"> ${describe(scope)}</label></li>`).join("")}</ul>` : ""}
       <p>It can never approve, queue or send email, delete records, change settings, or start, stop or cancel research jobs.</p>
       <div class="row">
         <button type="submit" name="decision" value="approve">Approve</button>
         <button type="submit" class="secondary" name="decision" value="deny">Deny</button>
       </div>
     </form>`,
  );
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
  } catch {
    return errorPage("Consent must be submitted from Growth.", 403);
  }
  const form = await request.formData();
  const values = CONSENT_FIELDS.map((name) => String(form.get(name) ?? ""));
  const [clientId, redirectUri, state, scope, challenge, method] = values;
  const decision = String(form.get("decision") ?? "");

  if (!clientId || !redirectUri) return errorPage("client_id and redirect_uri are required.");
  if (!(await clientAllowsRedirect(clientId, redirectUri))) {
    return errorPage("That redirect_uri is not registered for this connector.");
  }

  const user = await getSessionUser();
  if (!user) return errorPage("Sign in to Growth first, then reopen the connector.", 401);
  const ticket = String(form.get("consent_ticket") ?? "");
  const consent = pendingConsents.get(ticket);
  if (!consent || consent.userId !== user.id || consent.expiresAt <= Date.now() ||
      consent.fields.some((value, index) => value !== values[index])) {
    return errorPage("Consent expired or changed. Reopen the connector and review its permissions.", 403);
  }

  // The bound scope is literal: an empty approved grant must NOT become defaults.
  const requested = scope.split(/\s+/).filter(Boolean);
  const selected = [...new Set(form.getAll("approved_scope").map(String))];
  if (selected.some((entry) => !requested.includes(entry) || (DEFAULT_SCOPES as readonly string[]).includes(entry))) {
    return errorPage("A permission was not part of this consent request.", 403);
  }
  pendingConsents.delete(ticket);

  const target = new URL(redirectUri);

  if (decision !== "approve") {
    target.searchParams.set("error", "access_denied");
    if (state) target.searchParams.set("state", state);
    // 303, not the 307 default: the consent form is a POST, and the connector's callback
    // expects a GET. A 307 would replay the POST at their endpoint (405 Method Not Allowed).
    return NextResponse.redirect(target, 303);
  }

  const code = await createAuthorizationCode({
    clientId,
    redirectUri,
    scope: requested.filter((entry) =>
      (DEFAULT_SCOPES as readonly string[]).includes(entry) || selected.includes(entry),
    ).join(" "),
    userId: user.id,
    codeChallenge: challenge || null,
    codeChallengeMethod: method || null,
  });

  target.searchParams.set("code", code);
  if (state) target.searchParams.set("state", state);
  // RFC 9207: the authorization response carries the issuer, so the client can confirm the
  // code came from the server it trusted before it exchanges it.
  target.searchParams.set("iss", publicOrigin(request));
  return NextResponse.redirect(target, 303);
}