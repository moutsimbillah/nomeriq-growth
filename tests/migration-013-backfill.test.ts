import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";

/**
 * Migration 013 adds the agent and channel columns and backfills the rows that carry a connector
 * name — the four prospects and four drafts the connectors saved. Run twice against a throwaway
 * database: it must attribute exactly those rows, leave the rest alone, and be repeatable.
 */

const SQL = readFileSync("src/db/migrations/013_source_agent.sql", "utf8");
const STATEMENTS = SQL.split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

const PROSPECTS: [string, string | null, string | null][] = [
  ["f8602ca5-bf39-402b-84cd-21212da236fd", "Claude", "claude"],
  ["123d1e92-be6d-4754-a23c-d7958abce752", "Claude", "claude"],
  ["815a1cd5-86c5-4705-9402-ab6b98526c89", "Claude", "claude"],
  ["fa5981b5-b8d9-4a2e-acd8-89d4c0f2ee4a", "ChatGPT", "chatgpt"],
];
const STRANGER = "aaaaaaaa-0000-4000-8000-000000000003";
const ODD_NAME = "bbbbbbbb-0000-4000-8000-000000000004";

async function run() {
  const db = await getDb();
  for (const statement of STATEMENTS) await db.query(statement);
}

beforeAll(async () => {
  await ensureWorkspaceDefaults();
  const db = await getDb();
  for (const [id, client] of PROSPECTS) {
    await db.query(
      `INSERT INTO prospects (id, business_name, name_key, website_url, domain_key, categories,
                              qualification_status, status, created_by_type, source_client)
       VALUES ($1, $2, lower($2), $3, $3, '["forex"]'::jsonb, 'verified', 'verified', 'api', $4)
       ON CONFLICT (id) DO NOTHING`,
      [id, `Lead ${id.slice(0, 8)}`, `${id}.example`, client],
    );
    await db.query(
      `INSERT INTO drafts (id, prospect_id, kind, sequence, status, subject, body, recipient_email,
                           ai_generated, warnings, created_by_type, source_client)
       VALUES (gen_random_uuid(), $1, 'first_contact', 0, 'draft', 'Subject', $2, 'a@b.example',
               true, '[]'::jsonb, 'api', $3)`,
      [id, "A body long enough for the draft table.", client],
    );
  }
  // A row with no connector behind it, and one whose name matches nothing known.
  await db.query(
    `INSERT INTO prospects (id, business_name, name_key, website_url, domain_key, categories,
                            qualification_status, status, created_by_type)
     VALUES ($1, 'No Connector Co', 'no connector co', 'https://none.example', 'none.example',
             '["forex"]'::jsonb, 'verified', 'verified', 'founder')
     ON CONFLICT (id) DO NOTHING`,
    [STRANGER],
  );
  await db.query(
    `INSERT INTO prospects (id, business_name, name_key, website_url, domain_key, categories,
                            qualification_status, status, created_by_type, source_client)
     VALUES ($1, 'Odd Name Co', 'odd name co', 'https://odd.example', 'odd.example',
             '["forex"]'::jsonb, 'verified', 'verified', 'api', 'Some Crawler 2')
     ON CONFLICT (id) DO NOTHING`,
    [ODD_NAME],
  );
});

afterAll(async () => {
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

async function origins(table: "prospects" | "drafts") {
  const db = await getDb();
  const rows = await db.query<{ prospect_id?: string; id: string; source_agent: string | null; source_channel: string | null }>(
    table === "prospects"
      ? `SELECT id, source_agent, source_channel FROM prospects ORDER BY created_at`
      : `SELECT id, prospect_id, source_agent, source_channel FROM drafts ORDER BY created_at`,
  );
  return rows.rows;
}

describe("migration 013", () => {
  it("attributes the connector rows and nothing else", async () => {
    await run();

    const prospects = await origins("prospects");
    for (const [id, , agent] of PROSPECTS) {
      const row = prospects.find((r) => r.id === id)!;
      expect(row.source_agent).toBe(agent);
      expect(row.source_channel).toBe("mcp_oauth");
    }
    // A row with no source_client is left alone.
    const stranger = prospects.find((r) => r.id === STRANGER)!;
    expect(stranger.source_agent).toBeNull();
    expect(stranger.source_channel).toBeNull();
    // An unrecognised name becomes other, not a guess.
    const odd = prospects.find((r) => r.id === ODD_NAME)!;
    expect(odd.source_agent).toBe("other");
    expect(odd.source_channel).toBe("mcp_oauth");

    const drafts = await origins("drafts");
    for (const [id, , agent] of PROSPECTS) {
      const row = drafts.find((r) => r.prospect_id === id)!;
      expect(row.source_agent).toBe(agent);
      expect(row.source_channel).toBe("mcp_oauth");
    }
  });

  it("is safe to run again: a third pass changes nothing", async () => {
    const before = { prospects: await origins("prospects"), drafts: await origins("drafts") };
    await run();
    await run();
    expect({ prospects: await origins("prospects"), drafts: await origins("drafts") }).toEqual(before);
  });

  it("keeps the columns inside their allowed values", async () => {
    const db = await getDb();
    await expect(
      db.query(`UPDATE prospects SET source_agent = 'not-a-thing' WHERE id = $1`, [PROSPECTS[0][0]]),
    ).rejects.toThrow();
  });
});