import React from "react";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { transformSync } from "esbuild";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import * as transfer from "@/lib/product-truth-transfer";
import {
  PRODUCT_TRUTH_CONTENT_FIELDS,
  PRODUCT_TRUTH_IMPORT_MAX_BYTES,
  PRODUCT_TRUTH_LIMITS,
  formLinesToList,
  parseProductTruthImport,
  productTruthExportFileName,
  productTruthExportJson,
  productTruthExportObject,
  productTruthSaveBody,
  productTruthSaveSchema,
  productTruthToFormState,
  changedProductTruthFields,
} from "@/lib/product-truth-transfer";
import { closeDb, getDb } from "@/lib/db/client";
import { ensureBootstrapUser } from "@/lib/auth/session";
import { ensureWorkspaceDefaults, getProductTruth, saveProductTruth } from "@/lib/services/settings";
import type { ProductTruth } from "@/lib/types";

/**
 * Product Truth Import/Export: the file is the saved/read ProductTruth record, a round trip keeps all
 * nine content fields byte-for-byte, the file's metadata can never approve or version anything,
 * malformed files are refused with clear messages, and the shared limits are exactly the PUT limits.
 */

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

const saved: ProductTruth = {
  id: "8d6a2c1e-0000-4000-8000-000000000001",
  version: 12,
  status: "approved",
  oneLiner: "  Nomeriq is a white-label platform for signal businesses.  ",
  offerSummary: "Branded web app.\n\n- Member area\n- Payments\twith tabs\n",
  howItWorks: "We set it up.\r\nYou approve.\n\nThen \"launch\" — ✓ ünïcödé 🚀",
  pricingNotes: "From 300 USD/month.\nNo discounts.",
  integrations: "Telegram, Stripe",
  limitations: "\nNo performance claims.\n",
  approvedClaims: ["Setup takes two weeks, sometimes less.", "Works with \"Telegram\" groups", "  padded entry  "],
  prohibitedClaims: ["guaranteed results", "100% win rate"],
  discoveryQuestions: ["How do subscribers receive signals today?", "Who handles payments?"],
  approvedAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-02T11:30:00.000Z",
};

const contentOf = (truth: ProductTruth) =>
  Object.fromEntries(PRODUCT_TRUTH_CONTENT_FIELDS.map((key) => [key, truth[key]]));
const fileWith = (patch: Record<string, unknown>, base: Record<string, unknown> = productTruthExportObject(saved) as any) =>
  JSON.stringify({ ...base, ...patch });
const errorsOf = (text: string) => {
  const result = parseProductTruthImport(text);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.errors;
};

describe("export writes the exact saved/read ProductTruth record", () => {
  it("has exactly the ProductTruth keys in mapper order and drops anything extra", () => {
    const withExtra = { ...saved, secret: "x", approve: true } as unknown as ProductTruth;
    const exported = JSON.parse(productTruthExportJson(withExtra));
    expect(Object.keys(exported)).toEqual([
      "id", "version", "status", "oneLiner", "offerSummary", "howItWorks", "pricingNotes",
      "integrations", "limitations", "approvedClaims", "prohibitedClaims", "discoveryQuestions",
      "approvedAt", "updatedAt",
    ]);
    expect(exported).toEqual(saved);
    expect(productTruthExportFileName(saved)).toBe("nomeriq-product-truth-v12-approved.json");
    expect(productTruthExportFileName({ ...saved, status: "needs_review" })).toBe("nomeriq-product-truth-v12-draft.json");
  });
});

describe("round trip", () => {
  it("export -> import preserves all nine fields byte-for-byte, including whitespace, newlines and list order", () => {
    const result = parseProductTruthImport(productTruthExportJson(saved));
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(Object.keys(result.content).sort()).toEqual([...PRODUCT_TRUTH_CONTENT_FIELDS].sort());
    expect(result.content).toEqual(contentOf(saved));
    expect(result.metadata).toEqual({
      id: saved.id, version: 12, status: "approved", approvedAt: saved.approvedAt, updatedAt: saved.updatedAt,
    });
  });

  it("import -> form -> save body keeps every list entry as one entry and passes the PUT schema", () => {
    const result = parseProductTruthImport(productTruthExportJson(saved));
    if (!result.ok) throw new Error(result.errors.join("; "));
    const form = productTruthToFormState(result.content);
    expect(form.howItWorks).toBe(saved.howItWorks);
    const body = productTruthSaveBody(form, false);
    expect(body.approvedClaims).toEqual(saved.approvedClaims.map((entry) => entry.trim()));
    expect(body.prohibitedClaims).toEqual(saved.prohibitedClaims);
    expect(body.discoveryQuestions).toEqual(saved.discoveryQuestions);
    for (const key of transfer.PRODUCT_TRUTH_TEXT_FIELDS) expect(body[key]).toBe(saved[key]);
    expect(productTruthSaveSchema.parse(body)).toEqual(body);
  });

  it("form state of the saved record is unchanged after importing its own export", () => {
    const before = productTruthToFormState(saved);
    const result = parseProductTruthImport(productTruthExportJson(saved));
    if (!result.ok) throw new Error("import failed");
    expect(changedProductTruthFields(before, productTruthToFormState(result.content))).toEqual([]);
  });

  it("accepts a UTF-8 BOM and empty lists", () => {
    const result = parseProductTruthImport(`\uFEFF${fileWith({ approvedClaims: [], prohibitedClaims: [], discoveryQuestions: [] })}`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content.approvedClaims).toEqual([]);
  });

  it("accepts the nine content fields without metadata", () => {
    const result = parseProductTruthImport(JSON.stringify(contentOf(saved)));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.metadata).toEqual({});
  });
});

describe("imported metadata can never approve, version or identify a save", () => {
  it("returns only the nine content fields; approval comes solely from the clicked button", () => {
    const result = parseProductTruthImport(fileWith({ status: "approved", approvedAt: "2026-11-01T10:00:00.000Z", version: 999, id: "other" }));
    if (!result.ok) throw new Error(result.errors.join("; "));
    for (const key of ["id", "version", "status", "approvedAt", "updatedAt", "approve"]) {
      expect(result.content).not.toHaveProperty(key);
    }
    const body = productTruthSaveBody(productTruthToFormState(result.content), false);
    expect(body.approve).toBe(false);
    expect(Object.keys(body).sort()).toEqual([...PRODUCT_TRUTH_CONTENT_FIELDS, "approve"].sort());
  });

  it("refuses an `approve` key (or any other unknown key) instead of ignoring it", () => {
    expect(errorsOf(fileWith({ approve: true }))).toEqual(["Unknown field: approve."]);
    expect(errorsOf(fileWith({ approved_by: "x", extra: 1 }))).toEqual(["Unknown fields: approved_by, extra."]);
  });

  it("validates metadata types", () => {
    expect(errorsOf(fileWith({ version: "12" }))).toEqual(["version must be a whole number of 1 or more."]);
    expect(errorsOf(fileWith({ version: 0 }))).toEqual(["version must be a whole number of 1 or more."]);
    expect(errorsOf(fileWith({ version: 1.5 }))).toEqual(["version must be a whole number of 1 or more."]);
    expect(errorsOf(fileWith({ status: "live" }))).toEqual(['status must be "approved" or "needs_review".']);
    expect(errorsOf(fileWith({ id: "" }))).toEqual(["id must be a non-empty text value."]);
    expect(errorsOf(fileWith({ id: 7 }))).toEqual(["id must be a non-empty text value."]);
    expect(errorsOf(fileWith({ approvedAt: 5 }))).toEqual(["approvedAt must be null or an ISO date-time."]);
    expect(errorsOf(fileWith({ approvedAt: "yesterday" }))).toEqual(["approvedAt must be null or an ISO date-time."]);
    expect(errorsOf(fileWith({ updatedAt: null }))).toEqual(["updatedAt must be an ISO date-time."]);
    expect(parseProductTruthImport(fileWith({ status: "needs_review", approvedAt: null })).ok).toBe(true);
  });
});

describe("invalid files are refused with clear messages", () => {
  it("invalid JSON, non-object JSON and oversize files", () => {
    expect(errorsOf("{not json")).toEqual(["The file is not valid JSON."]);
    expect(errorsOf("")).toEqual(["The file is not valid JSON."]);
    for (const text of ["null", "[]", "\"text\"", "42"]) {
      expect(errorsOf(text)).toEqual(["The file must contain one Product Truth object, as written by Export."]);
    }
    const big = fileWith({ limitations: "x".repeat(PRODUCT_TRUTH_IMPORT_MAX_BYTES) });
    expect(errorsOf(big)[0]).toMatch(/larger than 1024 KB/);
  });

  it("missing fields are listed", () => {
    const { discoveryQuestions: _q, pricingNotes: _p, ...rest } = productTruthExportObject(saved);
    expect(errorsOf(JSON.stringify(rest))).toEqual(["Missing fields: pricingNotes, discoveryQuestions."]);
  });

  it("wrong types name the field", () => {
    expect(errorsOf(fileWith({ offerSummary: 5 }))).toEqual(["What Nomeriq offers (offerSummary) must be a string."]);
    expect(errorsOf(fileWith({ approvedClaims: "one claim" }))).toEqual(["Approved claims (approvedClaims) must be a list of text entries."]);
    expect(errorsOf(fileWith({ prohibitedClaims: ["ok", 3] }))).toEqual(["Prohibited claims (prohibitedClaims) entry 2 must be a string."]);
    expect(errorsOf(fileWith({ discoveryQuestions: null }))).toEqual(["Questions to ask prospects (discoveryQuestions) must be a list of text entries."]);
  });

  it("blank one-liner is refused (Save would refuse it too)", () => {
    expect(errorsOf(fileWith({ oneLiner: "" }))).toEqual(["One-line description (oneLiner) must not be empty."]);
    expect(errorsOf(fileWith({ oneLiner: "   " }))).toEqual(["One-line description (oneLiner) must not be empty."]);
  });

  it("list entries with embedded line breaks or blank entries are refused, never split or dropped", () => {
    expect(errorsOf(fileWith({ approvedClaims: ["first", "two\nlines"] }))).toEqual([
      "Approved claims (approvedClaims) entry 2 contains a line break; each entry must be a single line.",
    ]);
    expect(errorsOf(fileWith({ discoveryQuestions: ["windows\r\nbreak"] }))[0]).toMatch(/entry 1 contains a line break/);
    expect(errorsOf(fileWith({ prohibitedClaims: ["ok", "  "] }))).toEqual(["Prohibited claims (prohibitedClaims) entry 2 is empty."]);
  });

  it("reports every problem at once", () => {
    expect(errorsOf(fileWith({ approve: true, version: "x", oneLiner: 3 }))).toHaveLength(3);
  });
});

describe("limits are exactly the PUT limits, shared by import and the route", () => {
  const L = PRODUCT_TRUTH_LIMITS;
  const atLimit = {
    oneLiner: "a".repeat(L.oneLiner),
    offerSummary: "b".repeat(5000), howItWorks: "c".repeat(5000), pricingNotes: "d".repeat(5000),
    integrations: "e".repeat(5000), limitations: "f".repeat(5000),
    approvedClaims: Array.from({ length: L.approvedClaims.items }, () => "g".repeat(L.approvedClaims.chars)),
    prohibitedClaims: Array.from({ length: L.prohibitedClaims.items }, () => "h".repeat(L.prohibitedClaims.chars)),
    discoveryQuestions: Array.from({ length: L.discoveryQuestions.items }, () => "i".repeat(L.discoveryQuestions.chars)),
  };

  it("keeps one-liner and list limits without imposing a paragraph length limit", () => {
    expect(L).toEqual({
      oneLiner: 500,
      approvedClaims: { items: 100, chars: 1000 },
      prohibitedClaims: { items: 100, chars: 500 },
      discoveryQuestions: { items: 50, chars: 1000 },
    });
  });

  it.each(["offerSummary", "howItWorks", "pricingNotes", "integrations", "limitations"] as const)(
    "%s longer than 5000 characters imports and passes the save schema without truncation",
    (field) => {
      const longText = "Long founder-maintained paragraph.\n".repeat(1000);
      const record = { ...productTruthExportObject(saved), [field]: longText };
      const result = parseProductTruthImport(JSON.stringify(record));
      if (!result.ok) throw new Error(result.errors.join("; "));
      expect(result.content[field]).toBe(longText);
      const body = productTruthSaveBody(productTruthToFormState(result.content), false);
      expect(productTruthSaveSchema.parse(body)[field]).toBe(longText);
    },
  );

  it("at the limits: import and PUT both accept", () => {
    expect(parseProductTruthImport(JSON.stringify(atLimit)).ok).toBe(true);
    expect(productTruthSaveSchema.safeParse({ ...atLimit, approve: false }).success).toBe(true);
  });

  const over: [string, unknown, string][] = [
    ["oneLiner", "a".repeat(501), "One-line description (oneLiner) is longer than 500 characters."],
    ["approvedClaims", Array.from({ length: 101 }, () => "g"), "Approved claims (approvedClaims) has more than 100 entries."],
    ["approvedClaims", ["g".repeat(1001)], "Approved claims (approvedClaims) entry 1 is longer than 1000 characters."],
    ["prohibitedClaims", ["h".repeat(501)], "Prohibited claims (prohibitedClaims) entry 1 is longer than 500 characters."],
    ["prohibitedClaims", Array.from({ length: 101 }, () => "h"), "Prohibited claims (prohibitedClaims) has more than 100 entries."],
    ["discoveryQuestions", Array.from({ length: 51 }, () => "i"), "Questions to ask prospects (discoveryQuestions) has more than 50 entries."],
    ["discoveryQuestions", ["i".repeat(1001)], "Questions to ask prospects (discoveryQuestions) entry 1 is longer than 1000 characters."],
  ];
  it.each(over)("over the %s limit: import and PUT both refuse", (field, value, message) => {
    expect(errorsOf(JSON.stringify({ ...atLimit, [field]: value }))).toEqual([message]);
    expect(productTruthSaveSchema.safeParse({ ...atLimit, [field]: value, approve: false }).success).toBe(false);
  });

  it("PUT keeps its existing behaviour: questions optional, approve required boolean, unknown keys stripped", () => {
    const { discoveryQuestions: _q, ...withoutQuestions } = atLimit;
    expect(productTruthSaveSchema.safeParse({ ...withoutQuestions, approve: true }).success).toBe(true);
    expect(productTruthSaveSchema.safeParse({ ...atLimit }).success).toBe(false);
    expect(productTruthSaveSchema.safeParse({ ...atLimit, approve: "true" }).success).toBe(false);
    expect(productTruthSaveSchema.parse({ ...atLimit, approve: false, status: "approved" })).not.toHaveProperty("status");
  });

  it("the route parses with the shared schema, not a private copy", () => {
    const route = read("src/app/api/product-truth/route.ts");
    expect(route).toContain("productTruthSaveSchema.parse(await readJson(request))");
    expect(route).not.toMatch(/z\.object\(/);
  });
});

describe("form lines", () => {
  it("unsaved-edit detection compares what Save would store, so whitespace Save trims is not 'unsaved'", () => {
    const base = productTruthToFormState(contentOf(saved) as any);
    const clean = transfer.savedFormOf(base);
    expect(changedProductTruthFields(clean, transfer.savedFormOf({ ...base, oneLiner: `${base.oneLiner}   `, approvedClaims: `${base.approvedClaims}\n\n` }))).toEqual([]);
    expect(changedProductTruthFields(clean, transfer.savedFormOf({ ...base, pricingNotes: "Changed" }))).toEqual(["pricingNotes"]);
  });
  it("existing list parsing is unchanged: split lines, trim, drop blanks", () => {
    expect(formLinesToList(" a \r\n\n b\n")).toEqual(["a", "b"]);
    expect(formLinesToList("")).toEqual([]);
  });
});

describe("ProductTruthForm Import/Export controls", () => {
  function loadForm() {
    const code = transformSync(read("src/components/product-truth-form.tsx"), { loader: "tsx", format: "cjs", jsx: "automatic" }).code;
    const nativeRequire = createRequire(import.meta.url);
    const apiRequest = vi.fn(() => { throw new Error("Unexpected request"); });
    const load = (id: string) => {
      if (id === "next/navigation") return { useRouter: () => ({ refresh: vi.fn() }) };
      if (id === "@/lib/product-truth-transfer") return transfer;
      if (id === "./client-ui") {
        return {
          apiRequest,
          InlineError: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children),
          SubmitBar: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children),
        };
      }
      if (id === "./ui") return { Notice: () => null };
      return nativeRequire(id);
    };
    const mod = { exports: {} as Record<string, React.ComponentType<any>> };
    new Function("require", "module", "exports", code)(load, mod, mod.exports);
    return { ProductTruthForm: mod.exports.ProductTruthForm, apiRequest };
  }
  afterEach(() => vi.unstubAllGlobals());

  it("renders Import JSON and Export saved JSON (labelled with the saved version) with zero requests", () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network"); }));
    const { ProductTruthForm, apiRequest } = loadForm();
    const html = renderToStaticMarkup(React.createElement(ProductTruthForm, { truth: saved }));
    expect(html).toContain("Import JSON");
    expect(html).toContain("Export saved JSON (v12)");
    expect(html).toContain('accept="application/json,.json"');
    expect(html).toContain('type="file"');
    expect(html).toContain("Export downloads saved version 12 (approved)");
    expect(html).toContain("nothing is saved or approved until you choose a save button");
    expect(html).not.toContain("unsaved edits");
    // Saved values (incl. newlines) are what the form shows initially.
    expect(html).toContain("Then &quot;launch&quot; — ✓ ünïcödé 🚀");
    expect(fetch).not.toHaveBeenCalled();
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("import/export handlers never call the API, reset the file input, and Save remains the only writer", () => {
    const source = read("src/components/product-truth-form.tsx");
    expect(source.match(/apiRequest\(/g)).toHaveLength(1);
    expect(source).not.toMatch(/\bfetch\(/);
    const handlers = source.slice(source.indexOf("function exportSaved"), source.indexOf("async function save("));
    expect(handlers).toContain('input.value = ""');
    expect(handlers).toContain("parseProductTruthImport(text)");
    expect(handlers).toContain("productTruthExportJson(truth)");
    expect(handlers).not.toMatch(/apiRequest|router\.refresh|approve\s*[:=,)]/);
    expect(source).toContain("body: productTruthSaveBody(form, approve)");
  });
});

describe("database round trip through the real save/read services", () => {
  let userId = "";
  let original: ProductTruth;
  beforeAll(async () => {
    await ensureWorkspaceDefaults();
    userId = (await ensureBootstrapUser({ email: "truth-transfer@example.test", password: crypto.randomUUID(), name: "Truth transfer" })).id;
    original = await getProductTruth();
  });
  afterAll(async () => {
    // Put the singleton record's content and status back for later files.
    await saveProductTruth(
      { ...contentOf(original) as any, approve: original.status === "approved" && original.approvedClaims.length > 0 },
      userId,
    );
    await (await getDb()).query(`DELETE FROM users WHERE id = $1`, [userId]);
    await closeDb();
  });

  it("save -> read -> export -> import -> save reproduces the identical content as a new draft", async () => {
    const stored = await saveProductTruth(
      {
        oneLiner: "Synthetic transfer one-liner",
        offerSummary: "Line one\n\nLine three\twith tab",
        howItWorks: "Step 1\nStep 2",
        pricingNotes: "Not approved — do not quote.",
        integrations: "Telegram\nDiscord",
        limitations: "No guarantees.\nNo outcomes.\n".repeat(250).trim(),
        approvedClaims: ["Claim, with comma", "Claim \"quoted\""],
        prohibitedClaims: ["guaranteed"],
        discoveryQuestions: ["Question one?", "Question two?"],
        approve: true,
      },
      userId,
    );
    expect(stored.status).toBe("approved");
    const read1 = await getProductTruth();
    const result = parseProductTruthImport(productTruthExportJson(read1));
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.content).toEqual(contentOf(read1));

    // The file says approved, but the founder clicked Save draft: the new version is a draft.
    const again = await saveProductTruth(productTruthSaveBody(productTruthToFormState(result.content), false), userId);
    expect(again.status).toBe("needs_review");
    expect(again.approvedAt).toBeNull();
    expect(again.version).toBe(read1.version + 1);
    expect(again.id).toBe(read1.id);
    expect(contentOf(again)).toEqual(contentOf(read1));
  });
});
