import { describe, expect, it } from "vitest";

import { PROVIDER_CATALOG, PROVIDER_KINDS } from "@/lib/ai/provider-catalog";

/**
 * The Settings screen and the server registry both import `provider-catalog`, so they cannot
 * drift. What this test guards instead are the catalog's own invariants: every provider has a
 * valid kind and a label, and Brave — the reason the model and the search source were split —
 * stays search-only and model-free.
 */
describe("the provider catalog", () => {
  it("gives every provider a valid kind and a label", () => {
    for (const [slug, provider] of Object.entries(PROVIDER_CATALOG)) {
      expect(PROVIDER_KINDS, `${slug} kind`).toContain(provider.kinds);
      expect(provider.label.trim().length, `${slug} label`).toBeGreaterThan(0);
    }
  });

  it("keeps Brave search-only and model-free, which is the whole point of the split", () => {
    expect(PROVIDER_CATALOG.brave.kinds).toBe("search");
    expect(PROVIDER_CATALOG.brave.model).toBe("");
  });

  it("keeps every hosted provider on a real default model; only 'custom' starts empty", () => {
    for (const [slug, provider] of Object.entries(PROVIDER_CATALOG)) {
      if (provider.kinds === "search") continue; // Brave has no model by design.
      if (slug === "custom") continue; // The founder names the model when adding the gateway.
      expect(provider.model.trim().length, `${slug} default model`).toBeGreaterThan(0);
    }
  });
});
