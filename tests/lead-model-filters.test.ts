import { expect, it } from "vitest";
import { countActiveFilters, leadFilterQuery, readLeadFilters } from "@/lib/leads/leadFilters";

it("preserves the lead-model filters in bookmarked and Load more query strings", () => {
  const filters = readLeadFilters({ tier: "category_b", productFit: "unknown", minPriority: "30", audience: "1000", sort: "priority" });
  expect(filters).toMatchObject({ tier: "category_b", productFit: "unknown", minPriority: 30, audience: 1000, sort: "priority" });
  const query = new URLSearchParams(leadFilterQuery(filters).slice(1));
  expect(query.get("tier")).toBe("category_b");
  expect(query.get("minPriority")).toBe("30");
  expect(query.get("audience")).toBe("1000");
  expect(countActiveFilters(filters)).toBe(4);
});

it("Unknown audience is not zero and zero minimums survive serialization", () => {
  expect(readLeadFilters({ audience: "unknown" }).audience).toBe("unknown");
  const filters = readLeadFilters({ audience: "0", minPriority: "0", sort: "updated" });
  expect(filters).toMatchObject({ audience: 0, minPriority: 0, sort: "updated" });
  expect(leadFilterQuery(filters)).toContain("minPriority=0");
  expect(leadFilterQuery(filters)).toContain("audience=0");
  expect(countActiveFilters(filters)).toBe(2);
});

it("rejects unknown enums, decimal, negative, unsafe and over-100 priority values", () => {
  for (const value of ["-1", "1.5", "NaN", "101", "1e2", "9007199254740992"]) {
    expect(readLeadFilters({ minPriority: value }).minPriority).toBeUndefined();
  }
  const filters = readLeadFilters({ tier: "tier2", productFit: "excellent", audience: "999999999999999999999999", sort: "attacker" });
  expect(filters.tier).toBeUndefined();
  expect(filters.productFit).toBeUndefined();
  expect(filters.audience).toBeUndefined();
  expect(filters.sort).toBeUndefined();
});
