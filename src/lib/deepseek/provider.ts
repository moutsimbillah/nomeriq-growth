import { decryptSecret, encryptSecret } from "@/lib/auth/crypto";
import { getDb } from "@/lib/db/client";
import { extractChatUsage, type ChatTokenUsage } from "@/lib/ai/chat-usage";
import { AppError, iso } from "@/lib/utils";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";

/**
 * DeepSeek's own API mounts Search and Fetch at proprietary paths. Compatible
 * gateways often implement the same capabilities elsewhere — a common shape is
 * `/v1/search` plus `/v1/scrape`. These are the defaults; a custom endpoint can
 * override them per credential.
 */
export const DEEPSEEK_DEFAULT_SEARCH_PATH = "/v1/tools/search";
export const DEEPSEEK_DEFAULT_FETCH_PATH = "/v1/tools/fetch";

/** Paths probed, in order, when a custom endpoint has no explicit paths. */
export const SEARCH_PATH_CANDIDATES = [
  "/v1/tools/search",
  "/v1/search",
  "/search",
  "/v1/web/search",
] as const;

export const FETCH_PATH_CANDIDATES = [
  "/v1/tools/fetch",
  "/v1/scrape",
  "/v1/fetch",
  "/fetch",
  "/v1/contents",
] as const;

/**
 * Normalises a configurable endpoint path.
 *
 * Accepts an absolute path ("/v1/search") or a full URL on the same host. Returns
 * null for anything that is not a safe same-origin path, so a stored value can
 * never redirect credentials to another host.
 */
export function cleanEndpointPath(
  value: string | null | undefined,
): string | null {
  const raw = (value || "").trim();
  if (!raw) return null;
  let pathname = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      pathname = parsed.pathname + (parsed.search || "");
    } catch {
      return null;
    }
  }
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  // Reject traversal and control characters outright.
  if (pathname.includes("..") || /[\s<>"'`\\]/.test(pathname)) return null;
  return pathname.replace(/\/+$/, "") || null;
}

/**
 * Accepts the model identifiers real providers use, including the
 * vendor-prefixed forms served by OpenAI-compatible relays:
 * `deepseek/deepseek-chat`, `openai/gpt-4o`, `meta-llama/Llama-3.3-70B-Instruct`.
 *
 * The goal is to allow a custom endpoint's own naming while refusing anything
 * that could break the request body or smuggle structure into it: no whitespace,
 * quotes, braces, control characters, path traversal or empty segments.
 */
export function isValidModelName(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const model = value.trim();
  if (model.length < 2 || model.length > 160) return false;
  // Allowed characters cover vendor prefixes, versions and tags.
  if (!/^[A-Za-z0-9._:/@+-]+$/.test(model)) return false;
  // No leading/trailing separators, no empty or traversal segments.
  if (/^[._:/@+-]|[._:/@+-]$/.test(model)) return false;
  if (model.includes("..")) return false;
  if (model.split("/").some((segment) => segment.length === 0)) return false;
  return true;
}

export interface DeepSeekConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  source: "database" | "environment";
  /** Overrides DEEPSEEK_DEFAULT_SEARCH_PATH when set. */
  searchPath?: string | null;
  /** Overrides DEEPSEEK_DEFAULT_FETCH_PATH when set. */
  fetchPath?: string | null;
}

export interface DeepSeekSearchResult {
  title: string;
  url: string;
  snippet: string;
  summary: string;
  content: string;
  siteName: string | null;
  date: string | null;
  authority: number;
  rerankScore: number;
}

export interface DeepSeekUsage {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
  reportedUsage?: ChatTokenUsage | null;
}

export interface DeepSeekChatResult<T> {
  data: T;
  usage: DeepSeekUsage;
  raw: string;
}

export class DeepSeekError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DeepSeekError";
  }
}

export interface DeepSeekPublicSettings {
  configured: boolean;
  source: "database" | "environment" | null;
  baseUrl: string;
  model: string;
  /** Effective Search/Fetch paths; null means the DeepSeek default is in use. */
  searchPath: string | null;
  fetchPath: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  lastTestedAt: string | null;
}

/**
 * Normalises a DeepSeek base URL.
 *
 * DeepSeek's documentation presents the base URL both ways — `https://api.deepseek.com`
 * and `https://api.deepseek.com/v1` (the OpenAI-compatible spelling). Both are
 * reasonable for a founder to paste into Settings, so a trailing `/v1` is
 * stripped here. Every endpoint path this adapter builds already includes its own
 * version segment, so keeping it would produce `/v1/v1/tools/search`, which the
 * real API answers with a bare 404 that reads to the founder as "not found".
 */
export function cleanBaseUrl(value: string): string {
  const trimmed = (value || "").trim().replace(/\/+$/, "");
  if (!trimmed) return DEEPSEEK_DEFAULT_BASE_URL;
  const withoutVersion = trimmed.replace(/\/v1$/i, "");
  return withoutVersion || DEEPSEEK_DEFAULT_BASE_URL;
}

/**
 * Describes which connection-test step failed, against which URL, and what to
 * check. A bare "not found" from the provider is not actionable on its own.
 *
 * The base-URL hint is only correct when the official DeepSeek host is in use. A
 * founder who deliberately configured a custom OpenAI-compatible endpoint must
 * not be told their base URL is "wrong" — the real finding there is usually that
 * the host serves chat but does not implement DeepSeek's proprietary Search and
 * Fetch tools.
 */
function connectionStepError(
  step: string,
  url: string,
  baseUrl: string,
  error: unknown,
): DeepSeekError {
  const detail =
    error instanceof DeepSeekError
      ? error.message
      : error instanceof Error
        ? error.message
        : "unknown error";
  const isMissingPath =
    error instanceof DeepSeekError && (error.status === 404 || error.status === 405);
  const isOfficialHost = /^https:\/\/api\.deepseek\.com$/i.test(baseUrl);
  const lowerDetail = detail.toLowerCase();

  let hint = "";
  if (isMissingPath && isOfficialHost) {
    hint = ` The endpoint was not found at that path, which usually means the base URL is wrong — it should be ${DEEPSEEK_DEFAULT_BASE_URL} with no extra path.`;
  } else if (isMissingPath) {
    hint =
      ` This custom endpoint is reachable but does not answer ${step.toLowerCase()} at that path. ` +
      "An OpenAI-compatible host will usually serve /models and /chat/completions but not DeepSeek's proprietary " +
      "Search and Fetch tools, which the autonomous engine needs for discovery. " +
      "Use https://api.deepseek.com to run the engine, or keep this endpoint for chat only.";
  } else if (/insufficient balance|insufficient_quota|quota exceeded|no credit/i.test(lowerDetail)) {
    // The key and base URL are correct — the account simply has no funds. Say so
    // plainly, because "Insufficient Balance" alone does not tell a founder that
    // Search and Fetch are billed per successful request.
    hint =
      " Your API key and base URL are correct, but the DeepSeek account has no remaining balance. " +
      "Top up the account before running research: Search and Fetch are billed per successful request. " +
      "The engine will pause safely rather than overspend, but it cannot discover anything with a zero balance.";
  } else if (error instanceof DeepSeekError && error.status === 401) {
    hint = " Check that the API key is correct and active for this endpoint.";
  } else if (error instanceof DeepSeekError && error.status === 402) {
    hint = " The account is reachable but payment is required before requests will succeed.";
  }

  return new DeepSeekError(
    `${step} failed at ${url}: ${detail}${hint} (base URL in use: ${baseUrl})`,
    error instanceof DeepSeekError ? error.status : 0,
    "deepseek_test_step_failed",
    false,
  );
}

export async function resolveDeepSeekConfig(): Promise<{
  config: DeepSeekConfig | null;
  error: string | null;
}> {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT * FROM provider_credentials WHERE provider = 'deepseek' LIMIT 1`,
  );
  const row = result.rows[0];
  if (row?.encrypted_api_key) {
    try {
      return {
        config: {
          apiKey: decryptSecret(row.encrypted_api_key),
          baseUrl: cleanBaseUrl(row.base_url || DEEPSEEK_DEFAULT_BASE_URL),
          model: row.model || DEEPSEEK_DEFAULT_MODEL,
          source: "database",
          searchPath: row.search_path ?? null,
          fetchPath: row.fetch_path ?? null,
        },
        error: null,
      };
    } catch (error) {
      return {
        config: null,
        error:
          error instanceof Error
            ? `Stored DeepSeek key could not be decrypted: ${error.message}`
            : "Stored DeepSeek key could not be decrypted.",
      };
    }
  }
  const envKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (envKey) {
    return {
      config: {
        apiKey: envKey,
        baseUrl: cleanBaseUrl(
          process.env.DEEPSEEK_BASE_URL || DEEPSEEK_DEFAULT_BASE_URL,
        ),
        model: process.env.DEEPSEEK_MODEL || DEEPSEEK_DEFAULT_MODEL,
        source: "environment",
        searchPath: process.env.DEEPSEEK_SEARCH_PATH ?? null,
        fetchPath: process.env.DEEPSEEK_FETCH_PATH ?? null,
      },
      error: null,
    };
  }
  return {
    config: null,
    error:
      "DeepSeek is not configured. Add a DeepSeek API key in Settings or set DEEPSEEK_API_KEY on the server.",
  };
}

export async function getDeepSeekPublicSettings(): Promise<DeepSeekPublicSettings> {
  const db = await getDb();
  const result = await db.query<any>(
    `SELECT * FROM provider_credentials WHERE provider = 'deepseek' LIMIT 1`,
  );
  const row = result.rows[0];
  const envKey = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
  const resolved = await resolveDeepSeekConfig();
  return {
    configured: Boolean(resolved.config),
    source: row?.encrypted_api_key
      ? "database"
      : envKey
        ? "environment"
        : null,
    baseUrl:
      row?.base_url ||
      process.env.DEEPSEEK_BASE_URL ||
      DEEPSEEK_DEFAULT_BASE_URL,
    model:
      row?.model || process.env.DEEPSEEK_MODEL || DEEPSEEK_DEFAULT_MODEL,
    searchPath: row?.search_path ?? process.env.DEEPSEEK_SEARCH_PATH ?? null,
    fetchPath: row?.fetch_path ?? process.env.DEEPSEEK_FETCH_PATH ?? null,
    lastTestOk: row?.last_test_ok ?? null,
    lastTestMessage: row?.last_test_message ?? null,
    lastTestedAt: iso(row?.last_tested_at),
  };
}

export async function saveDeepSeekSettings(input: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  searchPath?: string | null;
  fetchPath?: string | null;
  userId: string;
}): Promise<DeepSeekPublicSettings> {
  const db = await getDb();
  const existing = await db.query<any>(
    `SELECT * FROM provider_credentials WHERE provider = 'deepseek' LIMIT 1`,
  );
  const existingRow = existing.rows[0];
  const apiKey = input.apiKey?.trim();
  if (!apiKey && !existingRow?.encrypted_api_key && !process.env.DEEPSEEK_API_KEY) {
    throw new AppError("Enter a DeepSeek API key.");
  }
  const encrypted = apiKey
    ? encryptSecret(apiKey)
    : existingRow?.encrypted_api_key;
  const baseUrl = cleanBaseUrl(
    input.baseUrl ||
      existingRow?.base_url ||
      process.env.DEEPSEEK_BASE_URL ||
      DEEPSEEK_DEFAULT_BASE_URL,
  );
  const model =
    input.model?.trim() ||
    existingRow?.model ||
    process.env.DEEPSEEK_MODEL ||
    DEEPSEEK_DEFAULT_MODEL;
  if (!/^https:\/\//i.test(baseUrl)) {
    throw new AppError("DeepSeek base URL must use HTTPS.");
  }
  if (!isValidModelName(model)) {
    throw new AppError(
      "Enter a valid model name. Vendor-prefixed identifiers such as deepseek/deepseek-chat are supported.",
    );
  }
  // Only persist a path the founder actually supplied; null keeps the default.
  const searchPath =
    input.searchPath === undefined
      ? (existingRow?.search_path ?? null)
      : cleanEndpointPath(input.searchPath);
  const fetchPath =
    input.fetchPath === undefined
      ? (existingRow?.fetch_path ?? null)
      : cleanEndpointPath(input.fetchPath);
  await db.query(
    `INSERT INTO provider_credentials
      (provider, encrypted_api_key, base_url, model, search_path, fetch_path,
       updated_by, updated_at)
     VALUES ('deepseek', $1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (provider) DO UPDATE SET
       encrypted_api_key = excluded.encrypted_api_key,
       base_url = excluded.base_url,
       model = excluded.model,
       search_path = excluded.search_path,
       fetch_path = excluded.fetch_path,
       updated_by = excluded.updated_by,
       updated_at = now()`,
    [encrypted, baseUrl, model, searchPath, fetchPath, input.userId],
  );
  return getDeepSeekPublicSettings();
}

export async function recordDeepSeekTest(input: {
  ok: boolean;
  message: string;
}): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE provider_credentials SET
      last_test_ok = $1, last_test_message = $2, last_tested_at = now(),
      updated_at = now()
     WHERE provider = 'deepseek'`,
    [input.ok, input.message.slice(0, 1000)],
  );
}

/* ------------------------------- rate limit ------------------------------- */

const limiterState = new Map<string, { nextAt: number }>();

async function waitForRateLimit(key: string, qps: number): Promise<void> {
  const safeQps = Math.max(1, Math.min(qps, 100));
  const interval = 1000 / safeQps;
  const now = Date.now();
  const state = limiterState.get(key) ?? { nextAt: now };
  const wait = Math.max(0, state.nextAt - now);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  limiterState.set(key, { nextAt: Date.now() + interval });
}

/* ------------------------------- retry logic ------------------------------ */

async function deepseekFetchJson<T>(input: {
  url: string;
  apiKey: string;
  method?: "GET" | "POST";
  body?: unknown;
  timeoutMs?: number;
  retry?: boolean;
}): Promise<{ data: T; status: number; headers: Headers }> {
  let lastError: DeepSeekError | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(input.url, {
        method: input.method ?? "POST",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: AbortSignal.timeout(input.timeoutMs ?? 45_000),
      });
      const text = await response.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!response.ok) {
        const message =
          parsed?.error?.message ||
          parsed?.message ||
          `DeepSeek returned HTTP ${response.status}.`;
        const retryable =
          response.status === 408 ||
          response.status === 429 ||
          response.status >= 500;
        const error = new DeepSeekError(
          String(message).slice(0, 500),
          response.status,
          `deepseek_http_${response.status}`,
          retryable,
        );
        if (!retryable || !input.retry || attempt === 2) throw error;
        lastError = error;
        const retryAfter = Number(response.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : 700 * 2 ** attempt + Math.round(Math.random() * 250);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      return { data: parsed as T, status: response.status, headers: response.headers };
    } catch (error) {
      if (error instanceof DeepSeekError) {
        if (!error.retryable || !input.retry || attempt === 2) throw error;
        lastError = error;
      } else {
        const message =
          error instanceof Error ? error.message : "DeepSeek request failed.";
        const retryable = /timeout|network|fetch failed|ECONN|ENOTFOUND/i.test(
          message,
        );
        if (!retryable || !input.retry || attempt === 2) {
          throw new DeepSeekError(
            message.slice(0, 500),
            0,
            "deepseek_network",
            retryable,
          );
        }
        lastError = new DeepSeekError(
          message.slice(0, 500),
          0,
          "deepseek_network",
          true,
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 700 * 2 ** attempt + Math.round(Math.random() * 250)),
      );
    }
  }
  throw lastError ?? new DeepSeekError("DeepSeek request failed.", 0, "deepseek_unknown", false);
}

/* -------------------------------- pricing -------------------------------- */

const MODEL_PRICES_PER_MILLION: Record<
  string,
  { hit: number; miss: number; output: number }
> = {
  "deepseek-flash": { hit: 0.006, miss: 0.3, output: 1.2 },
  "deepseek-v4-pro": { hit: 0.044, miss: 1.32, output: 3.96 },
};

export const DEEPSEEK_SEARCH_COST_USD = 0.00075;
export const DEEPSEEK_FETCH_COST_USD = 0.00075;

export function isDeepSeekPeak(now = new Date()): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = now.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function estimateDeepSeekModelCost(input: {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  at?: Date;
}): number {
  const price =
    MODEL_PRICES_PER_MILLION[input.model] ??
    MODEL_PRICES_PER_MILLION[DEEPSEEK_DEFAULT_MODEL];
  const factor = isDeepSeekPeak(input.at) ? 1 : 0.5;
  const cached = Math.max(0, Math.min(input.cachedInputTokens, input.inputTokens));
  const uncached = Math.max(0, input.inputTokens - cached);
  return (
    ((cached * price.hit + uncached * price.miss + input.outputTokens * price.output) /
      1_000_000) *
    factor
  );
}

/* ------------------------------ response shapes --------------------------- */

/**
 * Normalises a search result from either shape.
 *
 * DeepSeek returns `{ results: [{ title, url, snippet, summary, site_name,
 * rerank_score }] }`. Firecrawl-style gateways return
 * `{ data: { web: [{ title, url, description }] } }` or `{ data: [...] }`. Both
 * carry the same essentials, so accept whichever is present rather than failing
 * a working endpoint over a field name.
 */
function normalizeSearchResults(data: any): DeepSeekSearchResult[] {
  const raw = Array.isArray(data?.results)
    ? data.results
    : Array.isArray(data?.data?.web)
      ? data.data.web
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.web)
          ? data.web
          : [];
  return raw
    .map((item: any) => ({
      title: String(item?.title ?? item?.name ?? ""),
      url: String(item?.url ?? item?.link ?? ""),
      snippet: String(item?.snippet ?? item?.description ?? ""),
      summary: String(item?.summary ?? item?.description ?? ""),
      content: String(item?.content ?? item?.markdown ?? ""),
      siteName: item?.site_name ? String(item.site_name) : null,
      date: item?.date ? String(item.date) : null,
      authority: Number(item?.authority ?? -1),
      rerankScore: Number(item?.rerank_score ?? item?.score ?? 0),
    }))
    .filter((item: DeepSeekSearchResult) => Boolean(item.url));
}

/**
 * Normalises a fetched page from either shape: DeepSeek's `{ title, content }`
 * or a gateway's `{ data: { markdown | content | text } }`.
 *
 * Some gateways answer HTTP 200 and put the failure in the body — measured live,
 * `/v1/scrape` returned `{"error":"Failed to scrape page with Firecrawl"}` with
 * status 200. Treating that as an empty page hid the real reason behind a
 * misleading "not found", so a body-level error is raised as an error instead.
 */
function normalizeFetchedPage(data: any): { title: string; content: string } {
  const nested = data?.data ?? {};
  const bodyError =
    (typeof data?.error === "string" && data.error) ||
    (typeof nested?.error === "string" && nested.error) ||
    (typeof data?.error?.message === "string" && data.error.message) ||
    null;
  const content =
    data?.content ?? data?.markdown ?? data?.text ??
    nested.content ?? nested.markdown ?? nested.text ?? "";
  if (!content && bodyError) {
    throw new DeepSeekError(
      String(bodyError).slice(0, 300),
      502,
      "deepseek_fetch_failed",
      false,
    );
  }
  const title = data?.title ?? nested.title ?? nested.metadata?.title ?? "";
  return { title: String(title || ""), content: String(content || "") };
}

/* --------------------------------- Search -------------------------------- */

export async function deepseekSearch(
  config: DeepSeekConfig,
  input: { query: string; count?: number; qps?: number },
): Promise<{ results: DeepSeekSearchResult[]; costUsd: number; requestCount: number }> {
  if (!input.query.trim() || input.query.trim().length > 128) {
    throw new DeepSeekError("Search query must be 1–128 characters.", 400, "invalid_query", false);
  }
  await waitForRateLimit("deepseek-search", input.qps ?? 2);
  const path =
    cleanEndpointPath(config.searchPath) ?? DEEPSEEK_DEFAULT_SEARCH_PATH;
  const count = Math.max(1, Math.min(input.count ?? 20, 50));
  const { data } = await deepseekFetchJson<any>({
    url: `${config.baseUrl}${path}`,
    apiKey: config.apiKey,
    body: {
      query: input.query.trim(),
      count,
      need_content: true,
      // Gateways commonly expect one of these instead of `count`.
      limit: count,
      max_results: count,
    },
    retry: true,
  });
  const results = normalizeSearchResults(data);
  return {
    results,
    costUsd: results.length > 0 ? DEEPSEEK_SEARCH_COST_USD : 0,
    requestCount: results.length > 0 ? 1 : 0,
  };
}

/* ---------------------------------- Fetch -------------------------------- */

export async function deepseekFetchPage(
  config: DeepSeekConfig,
  input: { url: string; qps?: number },
): Promise<{ title: string; content: string; costUsd: number; requestCount: number }> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new DeepSeekError("Fetch URL is invalid.", 400, "invalid_url", false);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DeepSeekError("Fetch URL must be HTTP or HTTPS.", 400, "invalid_url", false);
  }
  if (url.username || url.password) {
    throw new DeepSeekError("Fetch URL must not contain credentials.", 400, "invalid_url", false);
  }
  await waitForRateLimit("deepseek-fetch", input.qps ?? 1);
  const path = cleanEndpointPath(config.fetchPath) ?? DEEPSEEK_DEFAULT_FETCH_PATH;
  const { data } = await deepseekFetchJson<any>({
    url: `${config.baseUrl}${path}`,
    apiKey: config.apiKey,
    body: {
      url: url.toString(),
      // Gateways differ: some accept `url`, others `urls`.
      urls: [url.toString()],
      formats: ["markdown"],
    },
    retry: true,
  });
  const page = normalizeFetchedPage(data);
  return {
    title: page.title,
    content: page.content,
    costUsd: page.content ? DEEPSEEK_FETCH_COST_USD : 0,
    requestCount: page.content ? 1 : 0,
  };
}

/* ----------------------------------- Chat -------------------------------- */

export function parseJsonObject(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new DeepSeekError("DeepSeek returned non-JSON content.", 502, "invalid_json", false);
    try {
      return JSON.parse(match[0]);
    } catch {
      throw new DeepSeekError("DeepSeek returned malformed JSON.", 502, "invalid_json", false);
    }
  }
}

export async function deepseekChatJson<T = unknown>(
  config: DeepSeekConfig,
  input: {
    system: string;
    user: string;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
  },
): Promise<DeepSeekChatResult<T>> {
  const { data } = await deepseekFetchJson<any>({
    url: `${config.baseUrl}/chat/completions`,
    apiKey: config.apiKey,
    body: {
      model: config.model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      temperature: input.temperature ?? 0.2,
      max_tokens: input.maxTokens ?? 1600,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
    },
    timeoutMs: input.timeoutMs ?? 60_000,
    retry: true,
  });
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new DeepSeekError(
      "DeepSeek returned an empty model response.",
      502,
      "empty_response",
      false,
    );
  }
  const usage = data?.usage ?? {};
  const inputTokens = Number(usage.prompt_tokens ?? 0);
  const cachedInputTokens = Number(
    usage.prompt_tokens_details?.cached_tokens ??
      usage.prompt_cache_hit_tokens ??
      0,
  );
  const outputTokens = Number(usage.completion_tokens ?? 0);
  const reported = extractChatUsage("deepseek", JSON.stringify(data));
  return {
    data: parseJsonObject(content) as T,
    raw: content,
    usage: {
      model: String(data?.model || config.model),
      inputTokens,
      cachedInputTokens,
      outputTokens,
      costUsd: estimateDeepSeekModelCost({
        model: config.model,
        inputTokens,
        cachedInputTokens,
        outputTokens,
      }),
      reportedUsage: reported,
    },
  };
}

/* ------------------------------ Connection test --------------------------- */

export async function listDeepSeekModels(
  config: DeepSeekConfig,
): Promise<string[]> {
  const { data } = await deepseekFetchJson<any>({
    url: `${config.baseUrl}/models`,
    apiKey: config.apiKey,
    method: "GET",
    retry: true,
  });
  return Array.isArray(data?.data)
    ? data.data.map((model: any) => String(model.id || "")).filter(Boolean)
    : [];
}

/**
 * Finds which candidate path a custom endpoint actually implements.
 *
 * A probe with a deliberately invalid key distinguishes the two cases reliably:
 * a route that exists answers 401/403 (authentication required), while a route
 * that does not exist answers 404/405. Returns null when nothing matches.
 */
async function detectEndpointPath(input: {
  baseUrl: string;
  apiKey: string;
  candidates: readonly string[];
  body: unknown;
}): Promise<string | null> {
  for (const candidate of input.candidates) {
    try {
      const response = await fetch(`${input.baseUrl}${candidate}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(input.body),
        signal: AbortSignal.timeout(15_000),
      });
      // 401/403 means the route exists and only the key is in question. With a
      // real key this same request would succeed, so treat it as the match.
      if (response.status === 401 || response.status === 403) return candidate;
      if (response.ok) return candidate;
      // 404/405 means no such route; keep looking.
    } catch {
      // Network hiccup on one candidate must not abort the whole search.
    }
  }
  return null;
}

export async function testDeepSeekConnection(config: DeepSeekConfig): Promise<{
  ok: boolean;
  message: string;
  models: string[];
  searchOk: boolean;
  fetchOk: boolean;
  costUsd: number;
  /** Paths that worked, so the caller can persist them for a custom endpoint. */
  searchPath: string | null;
  fetchPath: string | null;
}> {
  const modelsUrl = `${config.baseUrl}/models`;
  let models: string[];
  try {
    models = await listDeepSeekModels(config);
  } catch (error) {
    // Name the step, the URL and the base URL in use. DeepSeek answers an
    // unknown path with a minimal 404 body, so without this the founder only
    // sees "not found" and cannot tell what to fix.
    throw connectionStepError("Model list", modelsUrl, config.baseUrl, error);
  }

  let costUsd = 0;
  let searchOk = false;
  let fetchOk = false;

  const searchPath =
    cleanEndpointPath(config.searchPath) ?? DEEPSEEK_DEFAULT_SEARCH_PATH;
  const searchUrl = `${config.baseUrl}${searchPath}`;
  let search;
  try {
    search = await deepseekSearch(config, {
      query: '"forex signals" "VIP"',
      count: 2,
      qps: 1,
    });
  } catch (error) {
    // A custom endpoint may implement Search at a different path. Probe the
    // known conventions before declaring the capability missing.
    const isOfficialHost = /^https:\/\/api\.deepseek\.com$/i.test(config.baseUrl);
    if (!isOfficialHost && !config.searchPath) {
      const detected = await detectEndpointPath({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        candidates: SEARCH_PATH_CANDIDATES,
        body: { query: "forex signals", count: 2, limit: 2 },
      });
      if (detected && detected !== searchPath) {
        try {
          search = await deepseekSearch(
            { ...config, searchPath: detected },
            { query: '"forex signals" "VIP"', count: 2, qps: 1 },
          );
          costUsd += search.costUsd;
          searchOk = search.results.length > 0;
          return await finishTest({
            config,
            models,
            searchOk,
            costUsd,
            searchPath: detected,
            // Must carry the first result through, otherwise Fetch is never
            // exercised on a gateway whose Search lives at a custom path.
            firstResultUrl: search.results[0]?.url ?? null,
          });
        } catch {
          // Fall through to the original, clearer error below.
        }
      }
    }
    throw connectionStepError("Search", searchUrl, config.baseUrl, error);
  }
  costUsd += search.costUsd;
  searchOk = search.results.length > 0;

  return await finishTest({
    config,
    models,
    searchOk,
    costUsd,
    searchPath,
    firstResultUrl: search.results[0]?.url ?? null,
  });
}

/**
 * Completes a connection test once Search is known to work, including Fetch
 * detection for custom endpoints.
 */
async function finishTest(input: {
  config: DeepSeekConfig;
  models: string[];
  searchOk: boolean;
  costUsd: number;
  searchPath: string | null;
  firstResultUrl?: string | null;
}): Promise<{
  ok: boolean;
  message: string;
  models: string[];
  searchOk: boolean;
  fetchOk: boolean;
  costUsd: number;
  searchPath: string | null;
  fetchPath: string | null;
}> {
  const { config, models, searchOk } = input;
  let costUsd = input.costUsd;
  let fetchOk = false;
  let fetchPath =
    cleanEndpointPath(config.fetchPath) ?? DEEPSEEK_DEFAULT_FETCH_PATH;
  const isOfficialHost = /^https:\/\/api\.deepseek\.com$/i.test(config.baseUrl);

  if (input.firstResultUrl) {
    // Probe Fetch against the first search hit, then a stable, always-scrapable
    // URL, so one unreadable hit (a news/RSS redirect, a PDF, a login wall) cannot
    // make a working Fetch look broken.
    const probeUrls = [input.firstResultUrl, "https://example.com/"];

    // Candidate paths, deduplicated. The configured/default path comes first. On a
    // custom endpoint without an explicit path we also try the known conventions,
    // because a gateway may not use DeepSeek's proprietary mount point.
    const attemptPaths: string[] = [fetchPath];
    if (!isOfficialHost && !config.fetchPath) {
      for (const candidate of FETCH_PATH_CANDIDATES) {
        if (!attemptPaths.includes(candidate)) attemptPaths.push(candidate);
      }
    }

    // Keep the most informative failure. A detected path that fails for a real
    // reason (an upstream scraper error) explains far more than the bare
    // "Not found" returned by an absent default path, and would otherwise be
    // thrown away in favour of the less useful message.
    let bestError: string | null = null;
    let bestErrorPath: string | null = null;

    outer: for (const probeUrl of probeUrls) {
      for (const path of attemptPaths) {
        try {
          const page = await deepseekFetchPage(
            { ...config, fetchPath: path },
            // A bounded manual probe (at most a handful of requests), so it is not
            // paced like bulk research. The 1 req/s default would make a fully
            // failing endpoint take ~10s of pure throttling before reporting.
            { url: probeUrl, qps: 5 },
          );
          costUsd += page.costUsd;
          if (page.content) {
            fetchOk = true;
            fetchPath = path;
            break outer;
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : "unknown error";
          // A route that merely does not exist tells us nothing new; anything
          // else is a real explanation worth surfacing.
          if (!/not found|HTTP 404|HTTP 405/i.test(detail)) {
            if (!bestError || bestError.length < detail.length) {
              bestError = detail;
              bestErrorPath = path;
            }
          }
        }
      }
    }

    if (!fetchOk) {
      return {
        ok: models.length > 0 && searchOk,
        message:
          `Model API reachable (${models.length} models). ` +
          `${searchOk ? "Search working." : "Search returned no results for a common query."} ` +
          `Fetch could not retrieve a page: ${
            bestError ? `${bestError} (from ${bestErrorPath})` : "no Fetch endpoint responded."
          }`,
        models,
        searchOk,
        fetchOk: false,
        costUsd,
        searchPath: input.searchPath,
        fetchPath: null,
      };
    }
  }

  return {
    ok: models.length > 0 && searchOk,
    message:
      `Model API reachable (${models.length} models). ` +
      `${searchOk ? "Search working." : "Search returned no results for a common query."} ` +
      (input.firstResultUrl
        ? `${fetchOk ? "Fetch working." : "Fetch could not retrieve the first result."}`
        : "Fetch not exercised, because Search returned no page to read.") +
      (isOfficialHost
        ? ""
        : ` Custom endpoint detected: Search at ${input.searchPath ?? DEEPSEEK_DEFAULT_SEARCH_PATH}` +
          (fetchOk ? `, Fetch at ${fetchPath}.` : ".")),
    models,
    searchOk,
    fetchOk,
    costUsd,
    searchPath: input.searchPath,
    // Only report a Fetch path we actually proved. Returning the default here
    // would let the caller persist a route that was never exercised.
    fetchPath: fetchOk ? fetchPath : null,
  };
}
