export interface ChatProviderConfig {
  provider: string;
  baseUrl: string;
  model: string;
}
export interface ChatInput {
  system: string;
  user: string;
  maxTokens?: number;
  json?: boolean;
  /** Per HTTP attempt, including the entire response body. Defaults to 60 seconds. */
  timeoutMs?: number;
  /** Opt-in temporary-failure retries, clamped to 0–2; compatibility retries are separate. */
  transientRetries?: number;
  /** Opt-in code-only timing diagnostics, never prompts, provider names or credentials. */
  diagnosticTask?: "suggest_reply";
}
export interface ChatAttemptFailure {
  code: string;
  provider: string;
  attempt: number;
  status: number | null;
  elapsedMs: number;
  providerCode?: string;
}
export type TransportResult =
  | { ok: true; text: string; model: string }
  | { ok: false; code: string; reason: string; status?: number | null; elapsedMs?: number; providerCode?: string; failures?: ChatAttemptFailure[] };

const OPTIONAL_FIELDS = ["response_format", "max_tokens", "max_completion_tokens", "stream"] as const;
const RATE_CODES = new Set(["rate_limit", "rate_limit_exceeded", "rate_limit_error", "too_many_requests", "resource_exhausted", "429"]);
const CONTEXT_CODES = new Set(["context_length_exceeded", "context_window_exceeded", "input_too_long", "prompt_too_long", "request_too_large", "413"]);
const QUOTA_CODES = new Set(["insufficient_quota", "quota_exceeded", "billing_error", "billing_hard_limit_reached", "insufficient_balance", "credit_balance_too_low"]);
const AUTH_CODES = new Set(["authentication_error", "invalid_api_key", "permission_denied", "permission_error", "unauthenticated"]);
const TIMEOUT_CODES = new Set(["request_timeout", "timeout", "timeout_error", "deadline_exceeded", "408"]);
const SERVER_CODES = new Set(["server_error", "internal_error", "internal_server_error", "api_error", "overloaded_error", "unavailable", "internal"]);
const SAFE_CODES = new Set([...RATE_CODES, ...CONTEXT_CODES, ...QUOTA_CODES, ...AUTH_CODES, ...TIMEOUT_CODES, ...SERVER_CODES,
  "invalid_request", "invalid_request_error", "invalid_argument", "unsupported_parameter", "unknown_parameter", "unsupported_value", "model_not_found", "not_found_error"]);
/** Inspect the private body, but expose only allowlisted stable codes and known field names. */
export function safeProviderError(payload: unknown): { code: string | null; fields: typeof OPTIONAL_FIELDS[number][] } {
  const root = payload as { error?: { code?: unknown; type?: unknown; status?: unknown; param?: unknown; message?: unknown } } | null;
  const error = root?.error;
  const candidate = [error?.code, error?.type, error?.status].find(value =>
    (typeof value === "string" || typeof value === "number") && SAFE_CODES.has(String(value).toLowerCase()));
  const code = candidate === undefined ? null : String(candidate);
  const message = typeof error?.message === "string" ? error.message : "";
  const rejected = /unsupported|unknown|unrecognized|not supported|not allowed|not permitted|unexpected|use .+ instead|不支持/i.test(message);
  return {
    code,
    fields: OPTIONAL_FIELDS.filter((field) => error?.param === field || (rejected && message.includes(field))),
  };
}

function quotaFailure(payload: unknown): boolean {
  const error = (payload as { error?: { message?: unknown } } | null)?.error;
  // This private inspection only suppresses retries; no remote text is returned or logged.
  return typeof error?.message === "string" && /quota|billing|credit|balance|payment/i.test(error.message);
}

function failureCode(status: number | null, providerCode: string | null, quota = false): string {
  const code = providerCode?.toLowerCase() ?? "";
  if (status === 401 || status === 403 || AUTH_CODES.has(code)) return "http_error";
  if (status === 413 || CONTEXT_CODES.has(code)) return "context_size";
  if (status === 402 || quota || QUOTA_CODES.has(code)) return "quota_exceeded";
  if (status === 429 || RATE_CODES.has(code)) return "rate_limit";
  if (status === 408 || TIMEOUT_CODES.has(code)) return "request_timeout";
  if ((status !== null && status >= 500 && status <= 599) || SERVER_CODES.has(code)) return "provider_error";
  return "http_error";
}

function retryDelay(value: string | null, retry: number): number {
  const seconds = value && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const date = value ? Date.parse(value) : NaN;
  const requested = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? date - Date.now() : 0;
  return Math.max(retry * 1000, Math.min(10_000, Math.max(0, requested)));
}

function baseFor(config: ChatProviderConfig): string {
  const base = config.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
  return config.provider === "gemini" ? base.replace(/\/v1beta$/i, "") : base;
}
function authHeaders(provider: string, key: string): Record<string, string> {
  if (provider === "anthropic") return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  if (provider === "gemini") return { "x-goog-api-key": key };
  return { Authorization: `Bearer ${key}` };
}

/** Read a bounded JSON or SSE response. Stream metadata/reasoning is never mistaken for output. */
async function readResponse(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let raw = "";
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2_000_000) throw new InvalidResponseError("response_too_large");
      raw += decoder.decode(value, { stream: true });
    }
    return raw + decoder.decode();
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}
function textFromPayload(provider: string, payload: unknown): { text: string; model?: string } {
  const data = payload as {
    model?: string;
    content?: { type?: string; text?: string }[];
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    choices?: { message?: { content?: string }; delta?: { content?: string } }[];
  };
  if (provider === "anthropic") return { text: (data.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join(""), model: data.model };
  if (provider === "gemini") return { text: (data.candidates?.[0]?.content?.parts ?? []).filter(part => !part.thought).map(part => part.text ?? "").join("") };
  return { text: data.choices?.[0]?.message?.content ?? data.choices?.[0]?.delta?.content ?? "", model: data.model };
}
class InvalidResponseError extends Error {}
class StreamProviderError extends Error {
  public readonly providerCode: string | null;
  public readonly quota: boolean;
  constructor(payload: unknown) {
    super("stream_provider_error");
    this.providerCode = safeProviderError(payload).code;
    this.quota = quotaFailure(payload);
  }
}
function completion(provider: string, raw: string): { text: string; model?: string } {
  if (!raw.trimStart().startsWith("data:") && !raw.includes("\ndata:")) {
    const payload = JSON.parse(raw);
    if (payload?.error) throw new StreamProviderError(payload);
    return textFromPayload(provider, payload);
  }
  let text = "";
  let model: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const payload = JSON.parse(data);
    if (payload?.error) throw new StreamProviderError(payload);
    const part = textFromPayload(provider, payload);
    text += part.text;
    model = part.model || model;
  }
  return { text, model };
}

export async function listProviderModels(config: ChatProviderConfig, key: string): Promise<string[]> {
  const base = baseFor(config);
  const endpoint = config.provider === "gemini" ? `${base}/v1beta/models` : `${base}/v1/models`;
  const result: string[] = [];
  let next = endpoint;
  for (let page = 0; page < 10; page++) {
    const response = await fetch(next, { headers: authHeaders(config.provider, key), signal: AbortSignal.timeout(30000), redirect: "error" });
    if (!response.ok) {
      const safe = safeProviderError(await response.json().catch(() => null));
      throw new Error(`Model list returned HTTP ${response.status}${safe.code ? ` (code: ${safe.code})` : ""}.`);
    }
    const payload = await response.json();
    const rows = config.provider === "gemini" ? payload.models : payload.data;
    if (!Array.isArray(rows)) throw new Error("Model list returned an invalid response.");
    for (const row of rows) {
      if (config.provider === "gemini" && Array.isArray(row.supportedGenerationMethods) && !row.supportedGenerationMethods.includes("generateContent")) continue;
      const id = config.provider === "gemini" ? row.name?.replace(/^models\//, "") : row.id;
      if (typeof id === "string" && id) result.push(id);
    }
    if (config.provider === "gemini" && payload.nextPageToken) next = `${endpoint}?pageToken=${encodeURIComponent(payload.nextPageToken)}`;
    else if (config.provider === "anthropic" && payload.has_more && payload.last_id) next = `${endpoint}?after_id=${encodeURIComponent(payload.last_id)}`;
    else return [...new Set(result)];
  }
  throw new Error("Model list pagination exceeded its safety limit.");
}

/** One shared transport for real actions AND the provider Test. No vendor/domain-specific retries. */
export async function requestProviderChat(config: ChatProviderConfig, key: string, input: ChatInput): Promise<TransportResult> {
  const base = baseFor(config);
  const maxTokens = input.maxTokens ?? 4096;
  let url: string;
  const compatible = !["anthropic", "gemini"].includes(config.provider);
  let body: Record<string, unknown>;
  if (config.provider === "anthropic") {
    url = `${base}/v1/messages`;
    body = { model: config.model, max_tokens: maxTokens, system: input.system, messages: [{ role: "user", content: input.user }] };
  } else if (config.provider === "gemini") {
    url = `${base}/v1beta/models/${config.model}:generateContent`;
    body = { systemInstruction: { parts: [{ text: input.system }] }, contents: [{ role: "user", parts: [{ text: input.user }] }], generationConfig: { maxOutputTokens: maxTokens, ...(input.json ? { responseMimeType: "application/json" } : {}) } };
  } else {
    url = `${base}/v1/chat/completions`;
    body = {
      model: config.model,
      messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }],
      ...(config.provider === "openai" ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }),
      ...(input.json ? { response_format: { type: "json_object" } } : {}),
      // Streaming is part of the standard Chat Completions protocol. Some gateways require it.
      stream: true,
    };
  }
  const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs! > 0 ? input.timeoutMs! : 60_000;
  const retryLimit = Number.isFinite(input.transientRetries) ? Math.max(0, Math.min(2, Math.floor(input.transientRetries!))) : 0;
  const provider = ["openai", "anthropic", "gemini", "deepseek", "openrouter", "custom"].includes(config.provider) ? config.provider : "custom";
  const changed = new Set<string>();
  const failures: ChatAttemptFailure[] = [];
  let transientRetries = 0;
  let compatibilityRetries = 0;
  const diagnostic = (attempt: number, status: number | null, code: string, elapsedMs: number) => {
    if (input.diagnosticTask !== "suggest_reply") return;
    console.info("ai_chat_attempt", { task: input.diagnosticTask, provider, attempt, status, code,
      elapsed_ms: elapsedMs, context_chars: input.system.length + input.user.length });
  };
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    const controller = new AbortController();
    let status: number | null = null;
    let providerCode: string | null = null;
    let retryAfter: string | null = null;
    let compatibilityField: typeof OPTIONAL_FIELDS[number] | undefined;
    let code = "request_failed";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new DOMException("Request deadline exceeded", "TimeoutError"));
          controller.abort();
        }, timeoutMs);
      });
      const result = await Promise.race([deadline, (async () => {
        const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(config.provider, key) }, body: JSON.stringify(body), signal: controller.signal, redirect: "error" });
        status = response.status;
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          controller.signal.throwIfAborted();
        }
        retryAfter = response.headers.get("Retry-After");
        const raw = await readResponse(response, controller.signal);
        controller.signal.throwIfAborted();
        if (!response.ok) {
          let payload: unknown = null;
          try { payload = JSON.parse(raw); } catch { /* HTTP status remains authoritative. */ }
          const safe = safeProviderError(payload);
          providerCode = safe.code;
          code = failureCode(status, providerCode, quotaFailure(payload));
          const field = safe.fields.find(field => field in body && !changed.has(field));
          if (compatible && [400, 422].includes(response.status) && code === "http_error"
            && !AUTH_CODES.has(providerCode?.toLowerCase() ?? "") && field) compatibilityField = field;
          return null;
        }
        let parsed: ReturnType<typeof completion>;
        try { parsed = completion(config.provider, raw); }
        catch (error) {
          if (error instanceof SyntaxError || error instanceof StreamProviderError) throw error;
          throw new InvalidResponseError("invalid_response");
        }
        if (typeof parsed.text !== "string" || !parsed.text.trim()) {
          code = "empty_response";
          return null;
        }
        return { ok: true as const, text: parsed.text, model: parsed.model || config.model };
      })()]);
      if (result) {
        diagnostic(attempt, status, "success", Date.now() - started);
        return result;
      }
    } catch (error) {
      if (error instanceof StreamProviderError) {
        providerCode = error.providerCode;
        code = failureCode(null, providerCode, error.quota);
        if (code === "http_error") code = "stream_provider_error";
      } else if (controller.signal.aborted || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))) code = "request_timeout";
      else if (error instanceof SyntaxError) code = "invalid_response_json";
      else if (error instanceof InvalidResponseError) code = error.message;
      else code = "request_failed";
    } finally {
      clearTimeout(timer);
    }
    const failure: ChatAttemptFailure = { code, provider, attempt, status, elapsedMs: Date.now() - started,
      ...(providerCode ? { providerCode } : {}) };
    failures.push(failure);
    diagnostic(attempt, status, code, failure.elapsedMs);
    if (compatibilityField && compatibilityRetries < 3) {
      compatibilityRetries++;
      changed.add(compatibilityField);
      body = { ...body };
      delete body[compatibilityField];
      if (compatibilityField === "max_tokens" && !changed.has("max_completion_tokens")) body.max_completion_tokens = maxTokens;
      if (compatibilityField === "max_completion_tokens" && !changed.has("max_tokens")) body.max_tokens = maxTokens;
      continue;
    }
    const permanentStatus = status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
    const transient = ["rate_limit", "request_timeout", "provider_error", "request_failed"].includes(code)
      && (!permanentStatus || (code === "rate_limit" && status !== 401 && status !== 403 && status !== 402 && status !== 413));
    if (transient && transientRetries < retryLimit) {
      transientRetries++;
      await new Promise(resolve => setTimeout(resolve, retryDelay(retryAfter, transientRetries)));
      continue;
    }
    return { ok: false, code, reason: `Provider request failed (code: ${code}${status === null ? "" : `; HTTP ${status}`}${providerCode ? `; provider code: ${providerCode}` : ""}).`,
      status, elapsedMs: failure.elapsedMs, ...(providerCode ? { providerCode } : {}), failures };
  }
}
