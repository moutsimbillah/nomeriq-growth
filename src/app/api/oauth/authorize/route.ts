import { NextResponse } from "next/server";

import { getSessionUser } from "@/lib/auth/session";
import { loginRedirectUrl, publicOrigin } from "@/lib/app-url";
import {
  clientAllowsRedirect,
  createAuthorizationCode,
  getOAuthClient,
  scopesFromRequest,
} from "@/lib/oauth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
      headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    },
  );
}

function errorPage(message: string, status = 400) {
  return page("Request refused", `<h1>Request refused</h1><p>${message}</p>`, status);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id") ?? "";
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const scope = url.searchParams.get("scope") ?? "";
  const codeChallenge = url.searchParams.get("code_challenge");
  const codeChallengeMethod = url.searchParams.get("code_challenge_method");

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

  const fields = [
    ["client_id", clientId],
    ["redirect_uri", redirectUri],
    ["state", state],
    ["scope", scope],
    ["code_challenge", codeChallenge ?? ""],
    ["code_challenge_method", codeChallengeMethod ?? ""],
  ]
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${name}" value="${String(value).replace(/"/g, "&quot;")}">`,
    )
    .join("");

  return page(
    "Authorize connector",
    `<h1>Authorize “${client.client_name.replace(/[<>&]/g, "")}”</h1>
     <p>This connector is asking to read and write Growth research on your behalf, as <strong>${user.email}</strong>.</p>
     <p>It will be able to:</p>
     <ul>
       <li>read and write research, leads and drafts</li>
       <li>read progress and Product Truth</li>
       <li>check and record searches in the research ledger</li>
     </ul>
     <p>It can never send email, delete records, change settings or start a research job.</p>
     <form method="post" action="/api/oauth/authorize">${fields}
       <div class="row">
         <button type="submit" name="decision" value="approve">Approve</button>
         <button type="submit" class="secondary" name="decision" value="deny">Deny</button>
       </div>
     </form>`,
  );
}

export async function POST(request: Request) {
  const form = await request.formData();
  const clientId = String(form.get("client_id") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const state = String(form.get("state") ?? "");
  const scope = scopesFromRequest(form.get("scope")).join(" ");
  const codeChallenge = form.get("code_challenge") ? String(form.get("code_challenge")) : null;
  const codeChallengeMethod = form.get("code_challenge_method")
    ? String(form.get("code_challenge_method"))
    : null;
  const decision = String(form.get("decision") ?? "");

  if (!clientId || !redirectUri) return errorPage("client_id and redirect_uri are required.");
  if (!(await clientAllowsRedirect(clientId, redirectUri))) {
    return errorPage("That redirect_uri is not registered for this connector.");
  }

  const user = await getSessionUser();
  if (!user) return errorPage("Sign in to Growth first, then reopen the connector.", 401);

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
    scope,
    userId: user.id,
    codeChallenge,
    codeChallengeMethod,
  });

  target.searchParams.set("code", code);
  if (state) target.searchParams.set("state", state);
  // RFC 9207: the authorization response carries the issuer, so the client can confirm the
  // code came from the server it trusted before it exchanges it.
  target.searchParams.set("iss", publicOrigin(request));
  return NextResponse.redirect(target, 303);
}