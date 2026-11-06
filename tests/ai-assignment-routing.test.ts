import { describe, expect, it } from "vitest";

import {
  assignmentHealth,
  chatCapability,
  chatFallbacks,
  priorityConflicts,
  taskRouting,
  type ChatProviderOption,
} from "@/lib/ai/routing";

/**
 * The routing rules every provider type shares: who may answer a chat action, in what order, and how
 * a broken assignment is described. Pure functions, so these assertions are about the policy itself
 * rather than about a particular provider or a network call.
 */

function provider(over: Partial<ChatProviderOption> & { id: string }): ChatProviderOption {
  return {
    name: over.id,
    provider: "openai",
    kinds: "chat",
    model: "fixture-model",
    priority: 100,
    isEnabled: true,
    lastTestOk: true,
    ...over,
  };
}

describe("what may answer a chat action", () => {
  it("accepts every chat-capable provider type and refuses search-only or model-less rows", () => {
    for (const type of ["deepseek", "openai", "anthropic", "gemini", "openrouter", "custom"]) {
      expect(chatCapability({ provider: type, kinds: type === "deepseek" ? "both" : "chat", model: "m" }).ok).toBe(true);
    }
    expect(chatCapability({ provider: "brave", kinds: "search", model: "m", name: "Brave" }).ok).toBe(false);
    // A slug the catalog does not know cannot be answered for either.
    expect(chatCapability({ provider: "made-up", kinds: "chat", model: "m" }).ok).toBe(false);
    // A chat row that names no model is refused even when its kind says chat.
    expect(chatCapability({ provider: "openai", kinds: "chat", model: "" }).ok).toBe(false);
  });
});

describe("the failover order", () => {
  it("never offers a search-only, model-less or disabled provider", () => {
    const providers = [
      provider({ id: "brave-search", provider: "brave", kinds: "search", model: "" }),
      provider({ id: "no-model", model: "" }),
      provider({ id: "disabled", isEnabled: false }),
      provider({ id: "usable" }),
    ];
    expect(chatFallbacks(providers, null).map(p => p.id)).toEqual(["usable"]);
  });

  it("tries a test-passed provider before a failing one that shares its order number", () => {
    const providers = [
      provider({ id: "failed", priority: 100, lastTestOk: false }),
      provider({ id: "passed", priority: 100, lastTestOk: true }),
      provider({ id: "never-tested", priority: 100, lastTestOk: null }),
      provider({ id: "later", priority: 200 }),
    ];
    expect(chatFallbacks(providers, null).map(p => p.id)).toEqual(["passed", "failed", "never-tested", "later"]);
  });

  it("puts the task's own fallback list ahead of the global order", () => {
    const providers = [
      provider({ id: "global-first", priority: 10 }),
      provider({ id: "explicit", priority: 500 }),
    ];
    expect(chatFallbacks(providers, null, ["explicit"]).map(p => p.id)).toEqual(["explicit", "global-first"]);
  });

  it("skips the assigned provider in the chain after it", () => {
    const providers = [provider({ id: "assigned" }), provider({ id: "other", priority: 200 })];
    expect(chatFallbacks(providers, "assigned").map(p => p.id)).toEqual(["other"]);
  });

  it("names every order number shared by more than one live chat provider", () => {
    const providers = [
      provider({ id: "a", priority: 100 }),
      provider({ id: "b", priority: 100 }),
      provider({ id: "c", priority: 200 }),
      // A single occupant, a disabled row and a search-only row are not conflicts.
      provider({ id: "disabled", priority: 200, isEnabled: false }),
      provider({ id: "search", priority: 200, kinds: "search", model: "" }),
    ];
    expect(priorityConflicts(providers)).toEqual([100]);
  });
});

describe("how an assignment is described", () => {
  it("reports working, disabled, test-failed and not-assigned distinctly", () => {
    expect(assignmentHealth(null)).toMatchObject({ status: "not_assigned", label: "Not assigned" });
    expect(assignmentHealth(provider({ id: "ok" }))).toMatchObject({ status: "working", label: "Working" });
    expect(assignmentHealth(provider({ id: "off", isEnabled: false }))).toMatchObject({ status: "disabled" });
    expect(assignmentHealth(provider({ id: "bad", lastTestOk: false }))).toMatchObject({ status: "test_failed", label: "Test failed" });
    // A Test that has never run is not described as a failure.
    expect(assignmentHealth(provider({ id: "new", lastTestOk: null }))).toMatchObject({ status: "test_failed", label: "Test not passed" });
  });

  it("shows the next provider that would answer, and offers it as the switch target", () => {
    const providers = [
      provider({ id: "broken", priority: 10, isEnabled: false }),
      provider({ id: "working", priority: 100 }),
    ];
    const route = taskRouting(
      { providerId: "broken", model: "fixture-model", fallbacks: [] },
      providers,
    );
    expect(route.health.status).toBe("disabled");
    expect(route.fallback?.id).toBe("working");
    expect(route.replacement?.id).toBe("working");
  });

  it("offers no automatic fallback for an action that was never assigned", () => {
    const providers = [provider({ id: "working" })];
    const route = taskRouting({ providerId: null, model: null, fallbacks: [] }, providers);
    expect(route.health.status).toBe("not_assigned");
    // Nothing is chosen for it, which is what keeps Lead research unassigned until it is built.
    expect(route.fallback).toBeNull();
    expect(route.replacement).toBeNull();
  });

  it("uses the task's model override when one is set, and the provider's otherwise", () => {
    const providers = [provider({ id: "p", model: "provider-model" })];
    expect(taskRouting({ providerId: "p", model: "override", fallbacks: [] }, providers).model).toBe("override");
    expect(taskRouting({ providerId: "p", model: null, fallbacks: [] }, providers).model).toBe("provider-model");
  });
});
