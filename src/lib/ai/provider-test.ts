import { PROVIDER_CATALOG } from "@/lib/ai/provider-catalog";
import { listProviderModels, requestProviderChat, type ChatProviderConfig } from "@/lib/ai/chat-transport";

export interface ChatProbeResult {
  ok: boolean;
  chatOk: boolean;
  code: string | null;
  message: string;
  models: string[];
}
/** No stored messages are used. Success requires actual output from the selected, advertised model. */
export async function testProviderChat(config: ChatProviderConfig, key: string): Promise<ChatProbeResult> {
  let models: string[];
  try { models = await listProviderModels(config, key); }
  catch {
    return { ok: false, chatOk: false, code: "model_list_failed", message: "Model list failed. Check the provider URL and credential.", models: [] };
  }
  if (!models.includes(config.model)) return {
    ok: false, chatOk: false, code: "model_not_listed",
    message: "The selected model is not an exact ID in this provider's model list. Choose a listed model and test again.", models,
  };
  const documented = Boolean(PROVIDER_CATALOG[config.provider]?.documentedModels);
  const outcome = await requestProviderChat(config, key, {
    system: 'Return JSON only. Keep the final answer minimal.',
    user: 'Return exactly {"ok":true}.',
    // Forced-reasoning models need bounded room for reasoning as well as the tiny final answer.
    maxTokens: documented ? 4096 : 256,
    json: true,
  });
  if (!outcome.ok) return { ok: false, chatOk: false, code: outcome.code, message: `Chat failed (${outcome.code}): ${outcome.reason}`, models };
  let valid = false;
  try { valid = JSON.parse(outcome.text)?.ok === true; } catch { /* No provider output is exposed. */ }
  if (!valid) return { ok: false, chatOk: false, code: "invalid_chat_response", message: "Chat returned text but not the tiny JSON response requested by AI actions.", models };
  return { ok: true, chatOk: true, code: null,
    message: documented
      ? "Chat working (real tiny JSON completion). Model choices are documented IDs, not an account-discovered list."
      : `Model API reachable (${models.length} models). Chat working (real tiny JSON completion).`, models };
}
