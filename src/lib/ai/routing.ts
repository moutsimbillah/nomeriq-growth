import { PROVIDER_CATALOG } from "@/lib/ai/provider-catalog";

/** Browser-safe policy shared by Settings and the server; never import credentials here. */
export const AI_TASKS = [
  "translation", "suggest_reply", "simulate_reply", "first_email", "follow_up", "classification", "lead_research",
] as const;
export type AiTask = (typeof AI_TASKS)[number];
export const AI_TASK_LABELS: Record<AiTask, string> = {
  translation: "Translation",
  suggest_reply: "Suggest with AI",
  simulate_reply: "Simulate a test reply",
  first_email: "First-email drafting",
  follow_up: "Follow-up drafting",
  classification: "Classification",
  lead_research: "Lead research",
};

export interface ChatProviderOption {
  id: string;
  name: string;
  provider: string;
  kinds: string;
  model: string;
  priority: number;
  isEnabled: boolean;
  lastTestOk: boolean | null;
}

export function chatCapability(row: { kinds: string; model: string | null; name?: string; provider?: string }):
  { ok: true } | { ok: false; message: string } {
  const label = row.name ? `"${row.name}"` : "This provider";
  if (row.kinds === "search" || (row.provider && PROVIDER_CATALOG[row.provider]?.kinds === "search")) {
    return { ok: false, message: `${label} is a search-only provider, so it cannot be chosen for a chat task. Choose it as the search source instead.` };
  }
  if (!(row.model ?? "").trim()) {
    return { ok: false, message: `${label} has no model set, so it cannot be chosen for a chat task. Set a model on the provider first, or choose it as the search source.` };
  }
  if (row.provider && !PROVIDER_CATALOG[row.provider]) {
    return { ok: false, message: `${label} has an unsupported provider type.` };
  }
  return { ok: true };
}

export function searchCapability(row: { kinds: string; name?: string }): { ok: true } | { ok: false; message: string } {
  if (row.kinds === "chat") {
    const label = row.name ? `"${row.name}"` : "This provider";
    return { ok: false, message: `${label} is a model-only provider, so it cannot be used as the search source. Choose a provider that offers search, or leave it on the model's own search.` };
  }
  return { ok: true };
}

export function workingChatProvider(provider: ChatProviderOption): boolean {
  return provider.isEnabled && provider.lastTestOk === true && chatCapability(provider).ok;
}

/**
 * The failover order after the assigned provider.
 *
 * Explicit per-task fallbacks come first, then the rest of the global order. Providers that share an
 * order number are separated by their Test result — a test-passed provider is always tried before a
 * failing one — and then by name, so the order is total and never depends on insertion order.
 * Search-only and model-less rows are never candidates; a disabled row is not tried at all.
 */
export function chatFallbacks<T extends ChatProviderOption>(
  providers: readonly T[], primaryId: string | null, preferredIds: readonly string[] = [],
): T[] {
  const ordered = [...providers].sort((a, b) =>
    a.priority - b.priority ||
    Number(workingChatProvider(b)) - Number(workingChatProvider(a)) ||
    a.name.localeCompare(b.name),
  );
  const candidates = [...preferredIds.map(id => providers.find(p => p.id === id)), ...ordered];
  const seen = new Set(primaryId ? [primaryId] : []);
  return candidates.filter((provider): provider is T => {
    if (!provider || seen.has(provider.id) || !provider.isEnabled || !chatCapability(provider).ok) return false;
    seen.add(provider.id);
    return true;
  });
}

/** Order numbers shared by more than one live chat provider, so Settings can warn about them. */
export function priorityConflicts(providers: readonly ChatProviderOption[]): number[] {
  const counts = new Map<number, number>();
  for (const provider of providers) {
    if (!provider.isEnabled || !chatCapability(provider).ok) continue;
    counts.set(provider.priority, (counts.get(provider.priority) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([priority]) => priority).sort((a, b) => a - b);
}

export type AssignmentStatus = "working" | "disabled" | "test_failed" | "not_assigned";
export function assignmentHealth(provider: ChatProviderOption | null): { status: AssignmentStatus; label: string } {
  if (!provider) return { status: "not_assigned", label: "Not assigned" };
  if (!provider.isEnabled) return { status: "disabled", label: "Disabled" };
  if (!workingChatProvider(provider)) {
    // An invalidated/never-run Test is not falsely described as a network failure.
    return { status: "test_failed", label: provider.lastTestOk === null ? "Test not passed" : "Test failed" };
  }
  return { status: "working", label: "Working" };
}

/** No implicit global assignment for an unassigned action (especially Lead research). */
export function taskRouting<T extends ChatProviderOption>(
  task: { providerId: string | null; model: string | null; fallbacks: { providerId: string }[] },
  providers: readonly T[],
) {
  const assigned = providers.find(p => p.id === task.providerId) ?? null;
  const health = assignmentHealth(assigned);
  const next = task.providerId
    ? chatFallbacks(providers, task.providerId, task.fallbacks.map(f => f.providerId))[0] ?? null
    : null;
  const fallback = next;
  // An action that was never assigned needs no switch button — it has its own picker, and
  // inventing a provider here is exactly how an unbuilt action would start running by accident.
  const replacement = task.providerId && health.status !== "working" ? next : null;
  return { assigned, health, model: task.model?.trim() || assigned?.model || null, fallback, replacement };
}

/** An explicit whitelist: safe to serialize into Settings or return through the API. */
export function providerOption(provider: ChatProviderOption): ChatProviderOption {
  const { id, name, provider: type, kinds, model, priority, isEnabled, lastTestOk } = provider;
  return { id, name, provider: type, kinds, model, priority, isEnabled, lastTestOk };
}
