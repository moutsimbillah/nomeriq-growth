import { resolveAiTask } from "@/lib/ai/registry";
import { providerOption, type ChatProviderOption } from "@/lib/ai/routing";
import { ConfiguredResearchProvider, officialDeepSeek, researchAdapterError } from "@/lib/deepseek/configured-research-provider";
import { pricedResearchTool } from "@/lib/deepseek/research-pricing";
import type { ResearchProvider } from "@/lib/deepseek/research-provider";
import { FailoverResearchProvider } from "@/lib/deepseek/provider-pool";
import type { AiProviderRow } from "@/lib/ai/registry";
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

/** Read-only resolution. No legacy credentials/env, probes, metadata writes or implicit assignment. */
export async function resolveLeadResearch(input: { searchQps: number; fetchQps: number; jobId?: string } = { searchQps: 2, fetchQps: 1 }) {
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
    const error = researchAdapterError(row, "chat") ?? researchAdapterError(search, "search");
    tests.push({ chat: row, search, error });
    if (error) { publicConfig.warnings.push(error); continue; }
    const combined: ResearchProvider = new ConfiguredResearchProvider(row, search, {
      search: Math.max(1, Math.min(5, input.searchQps)), fetch: Math.max(1, Math.min(5, input.fetchQps)),
    }, input.jobId);
    entries.push({ name: row.name, provider: combined });
    if (!publicConfig.selected) {
      publicConfig.selected = providerOption(row);
      publicConfig.search = providerOption(search);
    }
    if ((!officialDeepSeek(row) || !["deepseek-flash", "deepseek-v4-pro"].includes(row.model) ||
      !pricedResearchTool(search, "search") || !pricedResearchTool(search, "fetch")) &&
      !publicConfig.warnings.some(warning => warning.startsWith("Cost unknown"))) {
      publicConfig.warnings.push("Cost unknown for unpriced calls in the configured chain. Known spend is tracked separately; the dollar budget cannot cap unknown charges. Request, rate and crawl limits still apply.");
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
