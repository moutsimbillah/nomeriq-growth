import { decryptSecret, encryptSecret } from "@/lib/auth/crypto";
import { getDb } from "@/lib/db/client";
import { AppError, iso } from "@/lib/utils";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";

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
    lastTestOk: row?.last_test_ok ?? null,
    lastTestMessage: row?.last_test_message ?? null,
    lastTestedAt: iso(row?.last_tested_at),
  };
}

export async function saveDeepSeekSettings(input: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
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
  await db.query(
    `INSERT INTO provider_credentials
      (provider, encrypted_api_key, base_url, model, updated_by, updated_at)
     VALUES ('deepseek', $1, $2, $3, $4, now())
     ON CONFLICT (provider) DO UPDATE SET
       encrypted_api_key = excluded.encrypted_api_key,
       base_url = excluded.base_url,
       model = excluded.model,
       updated_by = excluded.updated_by,
       updated_at = now()`,
    [encrypted, baseUrl, model, input.userId],
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

/* --------------------------------- Search -------------------------------- */

export async function deepseekSearch(
  config: DeepSeekConfig,
  input: { query: string; count?: number; qps?: number },
): Promise<{ results: DeepSeekSearchResult[]; costUsd: number; requestCount: number }> {
  if (!input.query.trim() || input.query.trim().length > 128) {
    throw new DeepSeekError("Search query must be 1–128 characters.", 400, "invalid_query", false);
  }
  await waitForRateLimit("deepseek-search", input.qps ?? 2);
  const { data } = await deepseekFetchJson<any>({
    url: `${config.baseUrl}/v1/tools/search`,
    apiKey: config.apiKey,
    body: {
      query: input.query.trim(),
      count: Math.max(1, Math.min(input.count ?? 20, 50)),
      need_content: true,
    },
    retry: true,
  });
  const results = Array.isArray(data?.results)
    ? data.results.map((item: any) => ({
        title: String(item.title || ""),
        url: String(item.url || ""),
        snippet: String(item.snippet || ""),
        summary: String(item.summary || ""),
        content: String(item.content || ""),
        siteName: item.site_name ? String(item.site_name) : null,
        date: item.date ? String(item.date) : null,
        authority: Number(item.authority ?? -1),
        rerankScore: Number(item.rerank_score ?? 0),
      }))
    : [];
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
  const { data } = await deepseekFetchJson<any>({
    url: `${config.baseUrl}/v1/tools/fetch`,
    apiKey: config.apiKey,
    body: { url: url.toString() },
    retry: true,
  });
  return {
    title: String(data?.title || ""),
    content: String(data?.content || ""),
    costUsd: data?.content ? DEEPSEEK_FETCH_COST_USD : 0,
    requestCount: data?.content ? 1 : 0,
  };
}

/* ----------------------------------- Chat -------------------------------- */

function parseJsonObject(text: string): unknown {
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

export async function testDeepSeekConnection(config: DeepSeekConfig): Promise<{
  ok: boolean;
  message: string;
  models: string[];
  searchOk: boolean;
  fetchOk: boolean;
  costUsd: number;
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

  const searchUrl = `${config.baseUrl}/v1/tools/search`;
  let search;
  try {
    search = await deepseekSearch(config, {
      query: '"forex signals" "VIP"',
      count: 2,
      qps: 1,
    });
  } catch (error) {
    throw connectionStepError("Search", searchUrl, config.baseUrl, error);
  }
  costUsd += search.costUsd;
  searchOk = search.results.length > 0;

  if (search.results[0]) {
    try {
      const page = await deepseekFetchPage(config, {
        url: search.results[0].url,
        qps: 1,
      });
      costUsd += page.costUsd;
      fetchOk = Boolean(page.content);
    } catch (error) {
      // Fetch is best effort: Search working already proves the key and base
      // URL, and an individual publisher's site may legitimately refuse Fetch.
      const detail = error instanceof Error ? error.message : "unknown error";
      return {
        ok: models.length > 0 && searchOk,
        message:
          `Model API reachable (${models.length} models). Search working. ` +
          `Fetch could not retrieve ${search.results[0].url}: ${detail}`,
        models,
        searchOk,
        fetchOk: false,
        costUsd,
      };
    }
  }

  return {
    ok: models.length > 0 && searchOk,
    message:
      `Model API reachable (${models.length} models). ` +
      `${searchOk ? "Search working." : "Search returned no results for a common query."} ` +
      `${fetchOk ? "Fetch working." : "Fetch could not retrieve the first result."}`,
    models,
    searchOk,
    fetchOk,
    costUsd,
  };
}
