import { getDb, closeDb } from "@/lib/db/client";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { CATEGORIES, PIPELINE } from "@/lib/types";
import { AGENT_TAGS, CHANNEL_TAGS } from "@/lib/agent/agentTag";

/** The qualification states the prospects table accepts, in the order the matrix cycles them. */
const QUALIFICATION_STATES = ["candidate", "verified", "rejected"] as const;

const BASE_CREATED_AT = new Date("2026-11-05T20:00:00.000Z");
const ARCHIVED_AT = "2026-12-01";

export async function seedFilterVerificationFixture(suffix: string) {
  await closeDb();
  process.env.DATABASE_URL = "";
  process.env.PGLITE_DIR = `.data/test-vitest-${process.pid}-matrix-${suffix}-${Date.now()}`;
  process.env.AUTO_MIGRATE = "true";
  await ensureWorkspaceDefaults();

  const db = await getDb();

  const jobRows = await db.query<{ id: string }>(
    `INSERT INTO research_jobs (id, name, target_count, status)
     VALUES
       (gen_random_uuid(), $1, 1, 'paused'),
       (gen_random_uuid(), $2, 1, 'paused')
     RETURNING id`,
    [`Fixture job ${suffix}`, `Fixture job ${suffix}`],
  );
  const jobs = jobRows.rows.map((row) => row.id);

  const senderRows = await db.query<{ id: string }>(
    `INSERT INTO email_accounts
       (id, name, provider, email_address, normalized_email, from_name, status, is_default)
     VALUES
       (gen_random_uuid(), $1, 'sandbox', $2, $2, 'Fixture A', 'connected', false),
       (gen_random_uuid(), $3, 'sandbox', $4, $4, 'Fixture B', 'connected', false)
     RETURNING id`,
    [
      `Fixture sender A ${suffix}`,
      `fixture-a-${suffix}@example.test`,
      `Fixture sender B ${suffix}`,
      `fixture-b-${suffix}@example.test`,
    ],
  );
  const senders = senderRows.rows.map((row) => row.id);

  const categories = CATEGORIES.map((category) => category.value);
  const agents = [...AGENT_TAGS, null];
  const channels = [...CHANNEL_TAGS, null];
  const senderIds = [null, senders[0], senders[1]];
  const jobIds = [null, jobs[0], jobs[1]];

  for (let i = 0; i < 450; i += 1) {
    const createdAt = new Date(BASE_CREATED_AT.getTime() - i * 6 * 60 * 60 * 1000);
    const updatedAt = new Date(BASE_CREATED_AT.getTime() - i * 1000);
    await db.query(
      `INSERT INTO prospects
         (id, business_name, name_key, created_by_type, website_url, country, status,
          qualification_status, categories, source_agent, source_channel, sending_profile_id,
          research_job_id, created_at, updated_at, archived_at)
       VALUES
         (gen_random_uuid(), $1, $2, 'api', $3, $4, $5, $6, $7::jsonb, $8, $9, $10,
          $11, $12, $13, $14)`,
      [
        `FilterFixture ${i}`,
        `matrix-fixture-${i}`,
        `fixture-${i}.example.test`,
        i % 2 === 0 ? "Matchland" : "Elsewhere",
        PIPELINE[i % PIPELINE.length],
        QUALIFICATION_STATES[i % QUALIFICATION_STATES.length],
        i % 3 === 0
          ? "[]"
          : JSON.stringify([
              categories[i % categories.length],
              categories[(i + 2) % categories.length],
            ]),
        agents[i % agents.length],
        channels[i % channels.length],
        senderIds[i % senderIds.length],
        jobIds[i % jobIds.length],
        createdAt,
        updatedAt,
        i % 41 === 0 ? ARCHIVED_AT : null,
      ],
    );
  }

  type ProspectRow = { id: string; source_agent: string | null; created_at: Date; updated_at: Date };
  const prospects = await db.query<ProspectRow>(
    `SELECT id, source_agent, created_at, updated_at FROM prospects ORDER BY created_at DESC`,
  );
  const draftStatuses = ["draft", "approved", "sent", "discarded", "cancelled"] as const;

  for (let i = 0; i < prospects.rows.length; i += 1) {
    const row = prospects.rows[i];
    if (i % 3 !== 0) {
      await db.query(
        `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url)
         VALUES (gen_random_uuid(), $1, $2, $2, 'https://example.test')`,
        [row.id, `matrix-${i}@example.test`],
      );
    }
    if (i % 10 === 0) {
      await db.query(
        `INSERT INTO prospect_emails (id, prospect_id, email, normalized_email, source_url)
         VALUES (gen_random_uuid(), $1, $2, $2, 'https://example.test')`,
        [row.id, `matrix-extra-${i}@example.test`],
      );
    }
    await db.query(
      `INSERT INTO drafts
         (id, prospect_id, kind, status, subject, body, recipient_email, created_by_type,
          source_agent, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'first_contact', $2, 'Fixture', 'Fixture',
               'fixture@example.test', 'api', $3, $4, $5)`,
      [row.id, draftStatuses[i % draftStatuses.length], row.source_agent, row.created_at, row.updated_at],
    );
    await db.query(
      `INSERT INTO conversations
         (id, prospect_id, subject, last_message_at, last_inbound_at, last_outbound_at, unread_count)
       VALUES (gen_random_uuid(), $1, 'Fixture', $2, $3, $4, $5)`,
      [
        row.id,
        row.created_at,
        i % 3 === 0 ? null : row.created_at,
        new Date(row.created_at.getTime() - 3_600_000),
        i % 4,
      ],
    );
  }

  return { jobs, senders };
}

export async function cleanupFilterVerificationFixture() {
  await closeDb();
}
