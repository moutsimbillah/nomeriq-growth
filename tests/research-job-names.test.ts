/**
 * One name per research target.
 *
 * The create form used to pre-fill one fixed batch name, so several targets shared
 * "Batch 02 — new commercial signal providers" and could not be told apart. The rule is enforced in
 * the service (against every stored target, archived included, with a message that names the target
 * already holding the name) and backed by a partial unique index for the statuses that can run.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/db/client";
import { ensureBootstrapUser } from "@/lib/auth/session";
import { createResearchJob, findResearchJobByName } from "@/lib/services/research";
import { normalizeResearchJobName, suggestResearchJobName } from "@/lib/utils";

let founder = "";
const created: string[] = [];
const unique = () => crypto.randomUUID().replaceAll("-", "").slice(0, 8);

async function makeJob(name: string) {
  const job = await createResearchJob({
    name,
    targetCount: 5,
    categories: ["forex"],
    engine: "manual",
    userId: founder,
  });
  created.push(job.id);
  return job;
}

beforeAll(async () => {
  founder = (
    await ensureBootstrapUser({
      email: `names-${crypto.randomUUID()}@fixture.test`,
      password: crypto.randomUUID(),
      name: "Synthetic",
    })
  ).id;
});

afterAll(async () => {
  const db = await getDb();
  if (created.length) await db.query(`DELETE FROM research_jobs WHERE id = ANY($1::uuid[])`, [created]);
  await closeDb();
});

describe("research target names", () => {
  it("refuses a second target with the same name and says which target holds it", async () => {
    const name = `Batch 90 — ${unique()}`;
    const first = await makeJob(name);
    const error = await makeJob(name).then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error).not.toBeNull();
    // The message names the target that already holds it, so the founder can find it.
    expect(error?.message).toContain("already exists");
    expect(error?.message).toContain(name);
    expect(error?.message).toContain("active");
    const holder = await findResearchJobByName(name);
    expect(holder?.id).toBe(first.id);
  });

  it("treats case, padding and repeated spaces as the same name", async () => {
    const name = `Batch 91 — ${unique()}`;
    await makeJob(name);
    await expect(makeJob(`   ${name.toUpperCase().replace(/ /g, "   ")}  `)).rejects.toThrow(
      /already exists/,
    );
  });

  it("allows a genuinely different name", async () => {
    const suffix = unique();
    const a = await makeJob(`Batch 92 — ${suffix}`);
    const b = await makeJob(`Batch 93 — ${suffix}`);
    expect(b.id).not.toBe(a.id);
  });

  it("refuses the name of an archived target too, so history stays unambiguous", async () => {
    const name = `Batch 94 — ${unique()}`;
    const job = await makeJob(name);
    const db = await getDb();
    await db.query(`UPDATE research_jobs SET status = 'archived' WHERE id = $1`, [job.id]);
    await expect(makeJob(name)).rejects.toThrow(/already exists/);
  });
});

describe("the database backs the rule for targets that can run", () => {
  it("refuses a direct insert of a second live target with the same name", async () => {
    const db = await getDb();
    const name = `Batch 95 — ${unique()}`;
    await makeJob(name); // manual targets are created active
    await expect(
      db.query(
        `INSERT INTO research_jobs (id, name, target_count, categories, engine, status, created_by)
         VALUES ($1, $2, 1, '["forex"]'::jsonb, 'manual', 'paused', $3)`,
        [crypto.randomUUID(), name.toUpperCase(), founder],
      ),
    ).rejects.toThrow();
  });

  it("still allows one stored name per status bucket when the first is closed", async () => {
    const db = await getDb();
    const name = `Batch 96 — ${unique()}`;
    const job = await makeJob(name);
    await db.query(`UPDATE research_jobs SET status = 'completed' WHERE id = $1`, [job.id]);
    // A closed target frees the name for the index, but the service still refuses it by design.
    await expect(makeJob(name)).rejects.toThrow(/already exists/);
  });
});

describe("the form is offered a free name", () => {
  it("normalises names the same way the database does", () => {
    expect(normalizeResearchJobName("  Batch   07  ")).toBe("batch 07");
  });

  it("offers one above the highest batch number already used", () => {
    expect(
      suggestResearchJobName([
        "Batch 02 — new commercial signal providers",
        "Batch 06 — new commercial signal providers",
      ]),
    ).toBe("Batch 07 — new commercial signal providers");
  });

  it("starts at 01 when no batch number exists yet", () => {
    expect(suggestResearchJobName([])).toBe("Batch 01 — new commercial signal providers");
    expect(suggestResearchJobName(["hemes"])).toBe("Batch 01 — new commercial signal providers");
  });

  it("skips a number that is already taken", () => {
    expect(
      suggestResearchJobName([
        "Batch 06 — new commercial signal providers",
        "Batch 07 — new commercial signal providers",
      ]),
    ).toBe("Batch 08 — new commercial signal providers");
  });
});