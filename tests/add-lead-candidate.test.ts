import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compileTsx } from "./helpers/tsx-loader";

const auth = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/auth/session", async (original) => ({
  ...(await original<typeof import("@/lib/auth/session")>()),
  requireEditor: async () => ({ id: auth.id, role: "founder" }),
}));

import { closeDb, getDb } from "@/lib/db/client";
import { ensureBootstrapUser } from "@/lib/auth/session";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { POST as portalPost } from "@/app/api/leads/route";

/**
 * Rule: a manually added lead is a candidate pending assessment. Typing details into the Add Lead
 * form is not an assessment, so the button, dialog and save caption never promise "verified", the
 * request asks for `candidate`, and no assessment/audience/contact-route evidence is fabricated.
 */

// --- Compile the real TSX (Next preserves JSX) with its real local imports. -----------------------
const req = createRequire(import.meta.url);
const srcRoot = path.resolve("src");
const componentFile = path.join(srcRoot, "components", "lead-actions.tsx");
const clientUiFile = path.join(srcRoot, "components", "client-ui.tsx");

// The real Modal portals onto document.body after a mount effect, which server rendering never
// runs. This stand-in renders the same title/description/children so the dialog copy is
// inspectable; the open/close behaviour is a browser concern, not this test's.
function StubModal({ open, title, description, children }: { open: boolean; title: string; description?: string; children: ReactNode }) {
  return createElement("div", { role: "dialog", "data-open": String(open), "aria-label": title },
    createElement("h2", { "data-modal-title": "" }, title),
    createElement("p", { "data-modal-description": "" }, description),
    children);
}
const overrides: Record<string, unknown> = {
  // CommonJS default export: return the function itself (see growth-testing skill).
  "next/link": ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement("a", { href, ...rest }, children),
  "next/navigation": { useRouter: () => ({ push() {}, refresh() {} }) },
};
const cache = new Map<string, { exports: Record<string, any> }>();
function resolveLocal(spec: string, fromDir: string) {
  const base = spec.startsWith("@/") ? path.join(srcRoot, spec.slice(2)) : path.resolve(fromDir, spec);
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const file = base + ext;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  throw new Error(`Cannot resolve ${spec} from ${fromDir}`);
}
function load(file: string): Record<string, any> {
  const hit = cache.get(file);
  if (hit) return hit.exports;
  const code = compileTsx(file);
  const mod = { exports: {} as Record<string, any> };
  cache.set(file, mod);
  const localRequire = (spec: string) => {
    if (spec in overrides) return overrides[spec];
    if (spec.startsWith("@/") || spec.startsWith(".")) {
      const resolved = resolveLocal(spec, path.dirname(file));
      const exported = load(resolved);
      return resolved === clientUiFile ? { ...exported, Modal: StubModal } : exported;
    }
    return req(spec);
  };
  new Function("require", "module", "exports", code)(localRequire, mod, mod.exports);
  return mod.exports;
}
const component = load(componentFile);

const fields = (key: string) => ({
  businessName: `Manual candidate ${key}`,
  websiteUrl: `https://${key}.example.test`,
  country: "",
  categories: ["forex"],
  email: `owner@${key}.example.test`,
  emailSourceUrl: `https://${key}.example.test/contact`,
  signalDescription: "Synthetic paid Forex signal service typed by the founder",
  pricingDetails: "",
  evidenceSummary: "",
  sourceUrl: `https://${key}.example.test/signals`,
  sourceLabel: "Official pricing or signal page",
  signalNotes: "",
  researchJobId: "",
  instagramUrl: "",
  youtubeUrl: "",
  xUrl: "",
  telegramUrl: "",
});

describe("manual Add Lead wording", () => {
  const html = renderToStaticMarkup(createElement(component.AddLeadButton, {
    jobs: [{ id: "00000000-0000-4000-8000-000000000001", name: "Synthetic target", status: "active" }],
  }));
  const dom = (attr: string) => html.match(new RegExp(`<[^>]*${attr}[^>]*>([^<]*)<`))?.[1] ?? "";

  it("the button, dialog and save caption say candidate pending assessment, never verified", () => {
    expect(html).toContain("Add candidate lead");
    expect(dom("data-modal-title")).toBe("Add a candidate lead (pending assessment)");
    expect(dom("data-modal-description")).toContain("candidate pending assessment");
    expect(html).toContain("Save candidate lead");
    for (const old of ["Add verified lead", "Save verified lead", "Add a verified commercial signal provider", "Verified country"]) {
      expect(html).not.toContain(old);
    }
    // The only mention of "verified" anywhere in the rendered form is the explicit negation.
    expect(html.replace("not as verified", "")).not.toMatch(/verified/i);
  });

  it("the request body asks for candidate and invents no assessment evidence", () => {
    const body = component.manualCandidateLeadBody(fields("shape"));
    expect(body.qualificationStatus).toBe("candidate");
    for (const key of ["leadAssessment", "audiences", "contactRoutes", "verifiedAt"]) expect(body).not.toHaveProperty(key);
    expect(JSON.stringify(body)).not.toMatch(/verified/i);
    expect(body.sources).toEqual([{ url: "https://shape.example.test/signals", label: "Official pricing or signal page", notes: "" }]);
    expect(body.researchJobId).toBeNull();
  });

  it("the form's submit sends that helper's body, not a hand-written verified payload", () => {
    const source = readFileSync(componentFile, "utf8");
    expect(source).toMatch(/apiRequest\("\/api\/leads", \{\s*body: manualCandidateLeadBody\(/);
    expect(source).not.toMatch(/qualificationStatus:\s*"verified"/);
  });
});

describe("manual Add Lead save through the real portal route", () => {
  const names: string[] = [];
  const sideEffects = ["outbound_sends", "drafts", "prospect_assessments", "prospect_audience_observations", "prospect_contact_route_observations"];
  const before = new Map<string, number>();
  const count = async (table: string) => Number((await (await getDb()).query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

  beforeAll(async () => {
    await ensureWorkspaceDefaults();
    auth.id = (await ensureBootstrapUser({ email: `add-lead-${crypto.randomUUID()}@example.test`, name: "Add lead founder", password: crypto.randomUUID() })).id;
    for (const table of sideEffects) before.set(table, await count(table));
  });
  afterAll(async () => {
    const db = await getDb();
    const ids = (await db.query<{ id: string }>("SELECT id FROM prospects WHERE business_name = ANY($1::text[])", [names])).rows.map((row) => row.id);
    for (const table of ["prospect_assessments", "prospect_audience_observations", "prospect_contact_route_observations", "prospect_sources", "prospect_emails", "prospect_aliases"]) {
      await db.query(`DELETE FROM ${table} WHERE prospect_id = ANY($1::uuid[])`, [ids]);
    }
    await db.query("DELETE FROM prospects WHERE id = ANY($1::uuid[])", [ids]);
    await db.query("DELETE FROM users WHERE id = $1", [auth.id]);
    await closeDb();
  });

  it("stores the manually added lead as an unassessed candidate and sends nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Manual Add Lead must not call any external service"); }));
    try {
      const key = crypto.randomUUID().replaceAll("-", "");
      const body = component.manualCandidateLeadBody(fields(key));
      names.push(body.businessName);
      const response = await portalPost(new Request("http://localhost:3100/api/leads", {
        method: "POST",
        headers: { origin: "http://localhost:3100", "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      const json = await response.json();
      expect(response.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.data.prospect.qualificationStatus).toBe("candidate");

      const db = await getDb();
      const row = (await db.query<{ qualification_status: string; verified_at: string | null; status: string }>(
        "SELECT qualification_status, verified_at, status FROM prospects WHERE id = $1", [json.data.prospect.id],
      )).rows[0];
      expect(row).toEqual({ qualification_status: "candidate", verified_at: null, status: "new" });
      for (const table of sideEffects) expect(await count(table)).toBe(before.get(table));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
