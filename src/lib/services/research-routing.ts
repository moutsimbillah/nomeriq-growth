import { decryptSecret } from "@/lib/auth/crypto";
import { resolveAiTask, type AiProviderRow } from "@/lib/ai/registry";
import { providerOption, type ChatProviderOption } from "@/lib/ai/routing";
import { DeepSeekResearchProvider, type ResearchProvider } from "@/lib/deepseek/research-provider";
import { FailoverResearchProvider } from "@/lib/deepseek/provider-pool";
import { cleanBaseUrl, type DeepSeekConfig } from "@/lib/deepseek/provider";
import { testResearchProvider } from "@/lib/services/research-provider-admin";

export interface ResearchConfiguration {
  configured: boolean;
  assigned: ChatProviderOption | null;
  selected: ChatProviderOption | null;
  search: ChatProviderOption | null;
  chain: ChatProviderOption[];
  error: string | null;
  warnings: string[];
}

// This repair deliberately retains the existing, priced adapter. Generic chat transport drops
// usage and native search adapters/prices are not implemented: never bill them as DeepSeek.
function adapterError(row: AiProviderRow, operation: "chat" | "search"): string | null {
  if (!row.isEnabled) return `${row.name} is disabled.`;
  let url: URL;
  try { url = new URL(row.baseUrl); } catch { return `${row.name} has an invalid URL.`; }
  if (row.provider !== "deepseek" || url.origin !== "https://api.deepseek.com" || !["", "/", "/v1", "/v1/"].includes(url.pathname)) {
    return `${row.name}: this research engine currently supports only the official DeepSeek adapter with known usage/pricing; other chat/search sources are not implemented.`;
  }
  if (operation === "chat" && !["deepseek-flash", "deepseek-v4-pro"].includes(row.model)) {
    return `${row.name}: research pricing is not implemented for model ${row.model}.`;
  }
  if (operation === "search" && row.kinds === "chat") return `${row.name} has no search/fetch capability.`;
  try {
    if (!decryptSecret(row.encryptedApiKey).trim()) return `${row.name} has no stored API key.`;
  } catch { return `${row.name}: the stored key cannot be read. Enter it again in Settings.`; }
  return null;
}

function config(row: AiProviderRow): DeepSeekConfig {
  return { apiKey: decryptSecret(row.encryptedApiKey), baseUrl: cleanBaseUrl(row.baseUrl),
    model: row.model, source: "database", searchPath: row.searchPath, fetchPath: row.fetchPath };
}

/** Read-only resolution. No legacy credentials/env, probes, metadata writes or implicit assignment. */
export async function resolveLeadResearch(input = { searchQps: 2, fetchQps: 1 }) {
  const publicConfig: ResearchConfiguration = { configured: false, assigned: null, selected: null,
    search: null, chain: [], error: null, warnings: [] };
  let selection;
  try { selection = await resolveAiTask("lead_research"); }
  catch { publicConfig.error = "The Lead research assignment is invalid or refers to a deleted/provider-incompatible row. Choose a chat provider and supported search source in Settings.";
    return { provider: null, configuration: publicConfig, error: publicConfig.error, tests: [] }; }
  publicConfig.assigned = selection.chat ? providerOption(selection.chat) : null;
  publicConfig.chain = selection.fallbackChain.map(providerOption);
  publicConfig.search = selection.search ? providerOption(selection.search) : null;
  const entries: { name: string; provider: ResearchProvider }[] = [];
  const tests: { chat: AiProviderRow; search: AiProviderRow; error: string | null }[] = [];
  for (const row of selection.fallbackChain) {
    const search = selection.search ?? row;
    const error = adapterError(row, "chat") ?? adapterError(search, "search");
    tests.push({ chat: row, search, error });
    if (error) { publicConfig.warnings.push(error); continue; }
    const chatAdapter = new DeepSeekResearchProvider(config(row));
    const searchAdapter = new DeepSeekResearchProvider(config(search), {
      search: Math.max(1, Math.min(5, input.searchQps)), fetch: Math.max(1, Math.min(5, input.fetchQps)),
    });
    // Each operation retains the actual serving row name, including a separate search source.
    let used: string | null = null;
    const combined: ResearchProvider = {
      get model() { return row.model; }, get lastUsedProvider() { return used; },
      lastUsedProviderFor: { search: search.name, fetch: search.name, chat: row.name },
      async search(value) { const out = await searchAdapter.search(value); used = search.name; return out; },
      async fetch(value) { const out = await searchAdapter.fetch(value); used = search.name; return out; },
      async chatJson<T>(value: { system: string; user: string; maxTokens?: number }) {
        const out = await chatAdapter.chatJson<T>(value); used = row.name; return out;
      },
    };
    entries.push({ name: row.name, provider: combined });
    if (!publicConfig.selected) {
      publicConfig.selected = providerOption(row);
      publicConfig.search = providerOption(search);
    }
  }
  publicConfig.configured = entries.length > 0;
  publicConfig.error = entries.length ? null : publicConfig.warnings[0] ?? (selection.chat
    ? "No enabled, test-passed chat fallback is available for Lead research."
    : "No provider is assigned to Lead research. Choose one in Settings.");
  if (selection.chat && selection.chat.lastTestOk !== true) publicConfig.warnings.push("The assigned provider's last Test has not passed. An enabled assignment is still tried; Test connection to check it now.");
  return { provider: entries.length ? new FailoverResearchProvider(entries) : null,
    configuration: publicConfig, error: publicConfig.error, tests };
}

export async function getResearchConfiguration(): Promise<ResearchConfiguration> {
  return (await resolveLeadResearch()).configuration;
}

/** Explicit founder/editor click only. Test the exact effective models and sources, not row defaults. */
export async function testLeadResearchConnection() {
  const resolved = await resolveLeadResearch();
  const results: { provider: string; model: string; ok: boolean; message: string }[] = [];
  const selected = resolved.tests.find(entry => entry.chat.id === resolved.configuration.selected?.id);
  // One explicit click tests the provider the engine would use, not every paid fallback.
  for (const entry of selected ? [selected] : resolved.tests.slice(0, 1)) {
    if (entry.error) {
      results.push({ provider: entry.chat.name, model: entry.chat.model, ok: false, message: entry.error });
      continue;
    }
    const chat = await testResearchProvider(entry.chat.id, { model: entry.chat.model, researchTools: entry.search.id === entry.chat.id });
    results.push({ provider: entry.chat.name, model: entry.chat.model, ...chat });
    if (entry.search.id !== entry.chat.id) {
      const search = await testResearchProvider(entry.search.id, { searchOnly: true });
      results.push({ provider: entry.search.name, model: "Search / Fetch", ...search });
    }
  }
  return { ok: results.length > 0 && results.every(result => result.ok),
    message: results.length ? "Connection test completed. No research job was started." : resolved.error,
    results, configuration: await getResearchConfiguration() };
}
