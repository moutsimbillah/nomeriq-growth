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
}
export type TransportResult =
  | { ok: true; text: string; model: string }
  | { ok: false; code: string; reason: string };

const OPTIONAL_FIELDS = ["response_format", "max_tokens", "max_completion_tokens", "stream"] as const;
/** Inspect the private error body, but expose only codes and known field names, never its text. */
export function safeProviderError(payload: unknown): { code: string | null; fields: string[] } {
  const root = payload as { error?: { code?: unknown; param?: unknown; message?: unknown } } | null;
  const error = root?.error;
  const code = typeof error?.code === "string" && /^[a-z_][a-z0-9_]{0,63}$/i.test(error.code)
    ? error.code : null;
  const message = typeof error?.message === "string" ? error.message : "";
  const rejected = /unsupported|unknown|unrecognized|not supported|not allowed|not permitted|unexpected|use .+ instead|不支持/i.test(message);
  return {
    code,
    fields: OPTIONAL_FIELDS.filter((field) => error?.param === field || (rejected && message.includes(field))),
  };
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
async function readResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2_000_000) throw new Error("response_too_large");
      raw += decoder.decode(value, { stream: true });
    }
    return raw + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
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
function completion(provider: string, raw: string): { text: string; model?: string } {
  if (!raw.trimStart().startsWith("data:") && !raw.includes("\ndata:")) {
    return textFromPayload(provider, JSON.parse(raw));
  }
  let text = "";
  let model: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const payload = JSON.parse(data);
    if (payload.error) throw new Error("stream_error");
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  const changed = new Set<string>();
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(config.provider, key) }, body: JSON.stringify(body), signal: controller.signal, redirect: "error" });
      if (!response.ok) {
        const safe = safeProviderError(await response.json().catch(() => null));
        // Retry only a named optional-field rejection before generation. Never retry auth/quota
        // failures, invent a model, or echo a remote error (it can contain an email or credential).
        const field = safe.fields.find(field => field in body && !changed.has(field));
        if (compatible && [400, 422].includes(response.status) && field) {
          changed.add(field);
          body = { ...body };
          delete body[field];
          if (field === "max_tokens" && !changed.has("max_completion_tokens")) body.max_completion_tokens = maxTokens;
          if (field === "max_completion_tokens" && !changed.has("max_tokens")) body.max_tokens = maxTokens;
          continue;
        }
        return { ok: false, code: "http_error", reason: `HTTP ${response.status}${safe.code ? ` (code: ${safe.code})` : ""}${safe.fields.length ? `; fields: ${safe.fields.join(", ")}` : ""}.` };
      }
      const result = completion(config.provider, await readResponse(response));
      if (typeof result.text !== "string" || !result.text.trim()) return { ok: false, code: "empty_response", reason: "Provider returned no text." };
      return { ok: true, text: result.text, model: result.model || config.model };
    }
    return { ok: false, code: "unsupported_fields", reason: "Provider rejected optional fields after the bounded compatibility retries." };
  } catch {
    return { ok: false, code: "request_failed", reason: "Provider request failed or returned an invalid response." };
  } finally {
    clearTimeout(timer);
  }
}
