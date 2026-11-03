/**
 * End-to-end verification of autonomous discovery over the real HTTP surface.
 *
 * Architecture:
 *   - A local stub server implements the DeepSeek HTTP contract (Search, Fetch,
 *     /models, /chat/completions). This exercises the REAL provider adapter
 *     (`deepseekSearch`, `deepseekFetchPage`, `deepseekChatJson`) over real HTTP,
 *     including JSON parsing, retries and cost accounting.
 *   - The built Next.js app runs against that stub via DEEPSEEK_BASE_URL.
 *   - The founder signs in, creates a DeepSeek target, and starts research
 *     through the authenticated engine route. The cron route is also exercised.
 *
 * No email is sent at any point, and no real DeepSeek request is made.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

// Load the same local secrets the app itself loads, so the harness and the app
// agree on CRON_SECRET. Parsed directly to keep this script dependency-free.
function loadEnvLocal() {
  let raw;
  try {
    raw = fsSync.readFileSync(".env.local", "utf8");
  } catch {
    return; // .env.local is optional
  }
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, key, value] = match;
    if (process.env[key] === undefined) {
      process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  }
}
loadEnvLocal();

const APP_PORT = 3199;
const STUB_PORT = 3198;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const PGLITE_DIR = ".data/e2e-engine";

const stats = { searches: 0, fetches: 0, chats: 0, models: 0 };

function log(step, detail = "") {
  console.log(`\n=== ${step} ===${detail ? `\n${detail}` : ""}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  console.log(`  ✓ ${message}`);
}

/* ------------------------------- DeepSeek stub ----------------------------- */

// One qualifying provider: publishes a paid signal subscription and a contact
// email, so it must be saved as a verified lead with a draft.
const SITE = {
  domain: "e2e-signals.example.com",
  name: "E2E Signal House",
  email: "desk@e2e-signals.example.com",
  home: `<html><body><h1>E2E Signal House</h1>
    <p>VIP forex and gold signals with entry, stop loss and take profit.</p>
    <p>Subscribe monthly for $49 per month. Join now.</p>
    <a href="/pricing">Pricing</a><a href="/contact">Contact</a></body></html>`,
  pricing: `<html><body><h1>Pricing</h1>
    <p>Signal subscription plans and membership pricing. $49 per month.</p></body></html>`,
  contact: `<html><body><h1>Contact</h1>
    <p>Email our team: desk@e2e-signals.example.com</p></body></html>`,
};

function readBody(request) {
  return new Promise((resolve) => {
    let data = "";
    request.on("data", (chunk) => (data += chunk));
    request.on("end", () => resolve(data));
  });
}

function startStub() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, STUB);
    const body = await readBody(request);
    const send = (payload) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    const parsed = body ? JSON.parse(body) : {};

    if (url.pathname === "/models") {
      stats.models += 1;
      return send({ data: [{ id: "deepseek-flash", object: "model" }] });
    }

    if (url.pathname === "/v1/tools/search") {
      stats.searches += 1;
      return send({
        results: [
          {
            rerank_score: 2.1,
            title: SITE.name,
            url: `https://${SITE.domain}/`,
            snippet: `${SITE.name} sells VIP trading signals.`,
            summary: `${SITE.name} offers a paid monthly signal subscription.`,
            content: "",
            site_name: SITE.name,
            site_icon: null,
            date: null,
            authority: 2,
          },
        ],
      });
    }

    if (url.pathname === "/v1/tools/fetch") {
      stats.fetches += 1;
      const target = String(parsed.url ?? "");
      const content = target.includes("/pricing")
        ? SITE.pricing
        : target.includes("/contact")
          ? SITE.contact
          : SITE.home;
      return send({ title: `${SITE.name} page`, content });
    }

    if (url.pathname === "/chat/completions") {
      stats.chats += 1;
      const user = String(parsed.messages?.find((m) => m.role === "user")?.content ?? "");
      const isDraft = /first-contact email/i.test(
        String(parsed.messages?.find((m) => m.role === "system")?.content ?? ""),
      );
      const data = isDraft
        ? {
            subject: `Question about your ${SITE.name} signal service`,
            body:
              "Hi there,\n\nI noticed you publish a monthly subscription for your VIP forex and gold signals, including entry, stop and target levels.\n\nI work on Nomeriq, a white-label platform for businesses that sell trading signals. One operational question: how does your team currently deliver signal updates and later take-profit revisions to subscribers?\n\nBest,\nFounder\nNomeriq",
          }
        : {
            isSignalProvider: true,
            sellsPaidSignals: true,
            categories: ["forex", "metals"],
            businessName: SITE.name,
            country: "Testland",
            signalDescription:
              "Sells monthly VIP forex and gold signal subscriptions with entry, stop-loss and take-profit levels.",
            pricingDetails: "$49 per month, published on the official pricing page.",
            evidenceSummary:
              "The official pricing page shows a paid signal subscription and the contact page publishes a business email.",
            contactEmail: SITE.email,
            emailSourceUrl: `https://${SITE.domain}/contact`,
            exclusionReason: null,
            confidence: 0.92,
            observation: `They publish a monthly $49 VIP signal subscription${user.includes("x") ? "" : ""}.`,
          };
      return send({
        model: "deepseek-flash",
        choices: [{ message: { role: "assistant", content: JSON.stringify(data) } }],
        usage: { prompt_tokens: 1500, completion_tokens: 300 },
      });
    }

    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  return new Promise((resolve) => server.listen(STUB_PORT, "127.0.0.1", () => resolve(server)));
}

/* --------------------------------- app client ------------------------------ */

let server;
const cookieJar = new Map();

async function request(pathname, options = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(cookieJar.size
        ? {
            Cookie: [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
          }
        : {}),
      ...(options.headers ?? {}),
    },
    redirect: "manual",
  });
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const index = pair.indexOf("=");
    if (index > 0) {
      cookieJar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* HTML page */
  }
  return { status: response.status, json, text };
}

async function waitForApp(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error("The app did not become ready in time.");
}

/* ------------------------------------ run --------------------------------- */

async function main() {
  await fs.rm(PGLITE_DIR, { recursive: true, force: true });
  const stub = await startStub();
  console.log(`DeepSeek stub listening on ${STUB}`);

  log("Starting the built Next.js app");
  server = spawn(
    process.execPath,
    [
      path.join("node_modules", "next", "dist", "bin", "next"),
      "start",
      "-p",
      String(APP_PORT),
    ],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "production",
        APP_URL: BASE,
        DATABASE_URL: "",
        PGLITE_DIR,
        AUTO_MIGRATE: "true",
        EMAIL_DELIVERY_MODE: "sandbox",
        ALLOW_PGLITE_PRODUCTION: "true",
        // The real provider adapter talks to the stub over real HTTP.
        DEEPSEEK_API_KEY: "e2e-stub-key",
        DEEPSEEK_BASE_URL: STUB,
        DEEPSEEK_MODEL: "deepseek-flash",
        RESEARCH_WORKER_MAX_JOBS: "2",
      },
    },
  );
  const appLog = [];
  server.stdout.on("data", (chunk) => appLog.push(String(chunk)));
  server.stderr.on("data", (chunk) => appLog.push(String(chunk)));

  await waitForApp();

  log("Health");
  assert((await request("/api/health")).status === 200, "health endpoint responds");

  log("First-run setup creates the founder (real bootstrap path)");
  const setup = await request("/api/auth/setup", {
    method: "POST",
    headers: { Origin: BASE },
    body: JSON.stringify({
      name: "E2E Founder",
      email: "founder@e2e.test",
      password: "E2eFounder!2026",
    }),
  });
  assert(setup.status === 200, `setup created the founder (status ${setup.status})`);

  log("Confirm the founder is signed in");
  const session = await request("/api/research/status");
  assert(
    session.status === 200,
    `authenticated request succeeded after setup (status ${session.status})`,
  );

  log("DeepSeek provider is reported as configured");
  const status0 = await request("/api/research/status");
  assert(status0.status === 200, "status route responds");
  assert(status0.json.data.deepseek.configured === true, "provider reported configured");

  log("Provider connectivity test against the stub (real adapter, real HTTP)");
  const test = await request("/api/settings/deepseek/test", {
    method: "POST",
    headers: { Origin: BASE },
  });
  assert(test.status === 200, `connection test succeeded (status ${test.status})`);
  assert(test.json.data.searchOk === true, "Search API verified");
  assert(test.json.data.fetchOk === true, "Fetch API verified");
  assert(test.json.data.models.includes("deepseek-flash"), "model list verified");
  assert(stats.searches > 0 && stats.fetches > 0, "stub observed real search and fetch calls");

  log("Create a DeepSeek research target");
  const created = await request("/api/research", {
    method: "POST",
    headers: { Origin: BASE },
    body: JSON.stringify({
      name: "E2E autonomous discovery",
      targetCount: 1,
      categories: ["forex", "metals"],
      regions: "Worldwide",
      requirements: "Paid trading-signal providers with a published business email.",
      engine: "deepseek",
      budgetUsd: 2,
    }),
  });
  assert(created.status === 200, `target created (status ${created.status})`);
  const job = created.json.data;
  assert(job.engine === "deepseek", "job uses the deepseek engine");
  assert(job.status === "paused", "a new engine job starts paused for budget review");

  log("Start research through the authenticated engine route");
  const started = await request(`/api/research/${job.id}/engine`, {
    method: "POST",
    headers: { Origin: BASE },
    body: JSON.stringify({ action: "start", runNow: true }),
  });
  assert(started.status === 200, `start accepted (status ${started.status})`);
  let state = started.json.data;
  console.log("  step notes:", JSON.stringify(state.tick.notes, null, 2));
  console.log("  stopReason:", state.tick.stopReason);

  log("Cron worker runs without a browser or chat session");
  const cron = await request("/api/cron/research", {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  assert(cron.status === 200, `cron accepted (status ${cron.status})`);
  assert(
    cron.json.data.note.includes("No email was sent"),
    "cron states plainly that no email was sent",
  );

  log("Cron rejects an unauthenticated caller");
  assert(
    (await request("/api/cron/research")).status === 401,
    "cron requires the shared secret",
  );

  log("Read the persisted outcome");
  const final = await request(`/api/research/${job.id}/engine`);
  assert(final.status === 200, "engine status readable");
  state = final.json.data;
  const j = state.job;
  console.log(
    `  verified=${j.verifiedCount} target=${j.targetCount} status=${j.status} ` +
      `candidates=${j.candidatesDiscovered} spent=$${Number(j.spentUsd).toFixed(6)}`,
  );
  console.log(`  usage: ${JSON.stringify(state.usage.recent.slice(0, 4))}`);

  assert(j.verifiedCount >= 1, "at least one real lead was verified and saved");
  assert(j.status === "completed", "job completed once the target was reached");
  assert(Number(j.spentUsd) > 0, "real DeepSeek cost was recorded");
  assert(
    Number(state.usage.costUsd) > 0 && state.usage.searches > 0,
    "usage shows real search operations and cost",
  );

  log("Create an assistant key so the lead can be read through the shared API");
  const keyResponse = await request("/api/api-keys", {
    method: "POST",
    headers: { Origin: BASE },
    body: JSON.stringify({
      name: "E2E reader",
      assistant: "deepseek",
      scopes: ["research:read", "progress:read", "conversations:read"],
    }),
  });
  assert(keyResponse.status === 200, `assistant key created (status ${keyResponse.status})`);
  const apiKey = keyResponse.json.data.key;

  async function agentRaw(action, args = {}) {
    const response = await fetch(`${BASE}/api/agent/v1/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(args),
    });
    return { status: response.status, json: await response.json() };
  }

  async function agent(action, args = {}) {
    const result = await agentRaw(action, args);
    // Surface a real error envelope instead of failing later on an undefined
    // field, which would hide the actual cause.
    if (result.status !== 200) {
      throw new Error(
        `agent tool ${action} failed (status ${result.status}): ${result.json?.error?.message ?? JSON.stringify(result.json)}`,
      );
    }
    return result;
  }

  log("The saved lead has real evidence and a published email");
  const search = await agent("search_prospects", { jobId: job.id, limit: 10 });
  assert(search.status === 200, `agent search readable (status ${search.status})`);
  const list = search.json.data.prospects ?? search.json.data ?? [];
  assert(list.length >= 1, `lead found through the shared API (${list.length})`);
  const lead = list.find((entry) => entry.contactEmail === SITE.email) ?? list[0];
  assert(lead.contactEmail === SITE.email, `published email stored: ${lead.contactEmail}`);
  assert(Boolean(lead.contactEmailSource), "email source URL stored");
  assert(String(lead.websiteUrl).includes(SITE.domain), "official website stored");
  assert(lead.qualificationStatus === "verified", "lead is verified");

  const detail = await agent("get_prospect", { prospectId: lead.id });
  assert(detail.status === 200, "lead detail readable through the shared API");
  const sources = detail.json.data.prospect.sources ?? [];
  assert(sources.length >= 1, `evidence sources stored (${sources.length})`);
  assert(
    sources.some((entry) => entry.url.includes("/pricing") || entry.url.includes("/contact")),
    "evidence includes the official pricing/contact pages",
  );

  log("Assistants can read the engine's real state but cannot control it");
  const jobRead = await agent("get_research_job", { jobId: job.id });
  assert(jobRead.status === 200, "get_research_job readable through the shared API");
  const reported = jobRead.json.data.job;
  assert(reported.engine === "deepseek", `job reports its engine: ${reported.engine}`);
  assert(reported.spentUsd > 0, `job reports real spend: $${reported.spentUsd}`);
  assert(
    reported.newVerifiedLeads === reported.target,
    `job reports honest counts: ${reported.newVerifiedLeads}/${reported.target}`,
  );
  const progress = await agent("report_progress");
  assert(progress.status === 200, "report_progress readable through the shared API");
  assert(
    (progress.json.data.jobs ?? []).length >= 1,
    "progress lists the persisted target",
  );
  // No job-control tool exists; an assistant must not be able to spend money.
  const controlled = await agentRaw("start_research_job", { jobId: job.id });
  assert(
    controlled.status === 404,
    "no job-control tool exists for assistants (status 404)",
  );

  log("A personalized first-contact draft was saved and NOT sent");
  const draftsResponse = await request(`/api/leads/${lead.id}/draft`);
  assert(
    draftsResponse.status === 200,
    `draft endpoint readable (status ${draftsResponse.status})`,
  );
  // This endpoint returns the single first-contact draft for the prospect.
  const draft = draftsResponse.json.data;
  assert(Boolean(draft), "a first-contact draft exists");
  assert(draft.status !== "sent", `draft status is '${draft.status}', not sent`);
  assert(Boolean(draft.subject), `draft has a subject: ${draft.subject}`);
  assert(draft.body.length > 40, "draft body is substantive");
  console.log("  draft subject:", draft.subject);

  log("Nothing was sent: no outbound message exists for this lead");
  // Checked at the prospect level, not through `list_conversations`, because
  // that tool only lists threads that already have a reply. A sent-but-unanswered
  // email would be invisible there and the assertion would be worthless.
  const convoResponse = await request(`/api/leads/${lead.id}/conversation`);
  assert(
    convoResponse.status === 200,
    `per-lead conversation route readable (status ${convoResponse.status})`,
  );
  assert(
    convoResponse.json.data === null,
    "no conversation exists for the lead, so no email was sent",
  );

  const outbound = await request(`/api/leads/${lead.id}/draft`);
  const outboundDraft = outbound.json?.data;
  assert(
    !outboundDraft || outboundDraft.status !== "sent",
    `the only draft is still '${outboundDraft?.status}', not sent`,
  );
  assert(!outboundDraft?.sentAt, "the draft has no sent timestamp");

  log("Completed jobs never restart from zero");
  const before = { ...stats };
  const again = await request(`/api/research/${job.id}/engine`, {
    method: "POST",
    headers: { Origin: BASE },
    body: JSON.stringify({ action: "start", runNow: true }),
  });
  // A completed job cannot be restarted; the route must refuse or no-op safely.
  const restarted = again.json?.data?.job ?? state.job;
  assert(
    restarted.status === "completed" || again.status >= 400,
    `completed job was not restarted (status ${again.status}, job ${restarted.status})`,
  );
  assert(
    stats.searches === before.searches,
    "no further search spend occurred after completion",
  );

  log("Research page renders with the engine panel");
  const page = await request("/research");
  assert(page.status === 200, `research page rendered (status ${page.status})`);
  assert(page.text.includes("Autonomous discovery"), "engine panel present");

  console.log("\n================ E2E ENGINE VERIFICATION PASSED ================");
  console.log(
    `Real HTTP calls through the provider adapter — searches: ${stats.searches}, ` +
      `fetches: ${stats.fetches}, model calls: ${stats.chats}, model list: ${stats.models}`,
  );
  console.log("No email was sent. Every draft is awaiting founder review in Growth.");
}

main()
  .catch((error) => {
    console.error("\n================ E2E VERIFICATION FAILED ================\n");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    server?.kill("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await fs.rm(PGLITE_DIR, { recursive: true, force: true }).catch(() => undefined);
    process.exit(process.exitCode ?? 0);
  });
