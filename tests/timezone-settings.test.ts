import { afterAll, beforeAll, expect, it } from "vitest";

import { closeDb, getDb } from "@/lib/db/client";
import {
  getWorkspaceSettings,
  updateWorkspaceSettings,
} from "@/lib/services/settings";

/**
 * The workspace timezone is the string every day-window is resolved through Intl,
 * so settings must refuse a zone the shared dates helper cannot resolve and must
 * never store a raw offset like +05:00.
 */

const FIXTURE_EMAIL = "timezonefixture@example.test";
let userId = "";
let initialTimezone = "";

beforeAll(async () => {
  const db = await getDb();
  initialTimezone = (await getWorkspaceSettings()).timezone;
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO users (id, email, normalized_email, name, password_hash, role)
     VALUES (gen_random_uuid(), $1, $1, 'Fixture', 'unusable-fixture', 'founder')
     RETURNING id`,
    [FIXTURE_EMAIL],
  );
  userId = inserted.rows[0].id;
});

afterAll(async () => {
  const db = await getDb();
  await db.query(
    `UPDATE workspace_settings SET timezone = $1 WHERE id = 'default'`,
    [initialTimezone],
  );
  await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await closeDb();
});

it("starts from the fresh default Asia/Karachi before any mutation", async () => {
  const settings = await getWorkspaceSettings();
  expect(settings.timezone).toBe("Asia/Karachi");
  const db = await getDb();
  const row = await db.query<{ timezone: string }>(
    `SELECT timezone FROM workspace_settings WHERE id = 'default'`,
  );
  expect(row.rows[0].timezone).toBe("Asia/Karachi");
});

it("rejects an unknown zone as invalid_timezone and leaves the timezone unchanged", async () => {
  const before = (await getWorkspaceSettings()).timezone;
  await expect(
    updateWorkspaceSettings({ timezone: "Nope/Zone" }, userId),
  ).rejects.toMatchObject({ code: "invalid_timezone" });
  expect((await getWorkspaceSettings()).timezone).toBe(before);
});

it("rejects a raw UTC offset like +05:00 the same way", async () => {
  const before = (await getWorkspaceSettings()).timezone;
  await expect(
    updateWorkspaceSettings({ timezone: "+05:00" }, userId),
  ).rejects.toMatchObject({ code: "invalid_timezone" });
  expect((await getWorkspaceSettings()).timezone).toBe(before);
});

it("persists America/New_York and reads it back from both paths", async () => {
  const returned = await updateWorkspaceSettings(
    { timezone: "America/New_York" },
    userId,
  );
  expect(returned.timezone).toBe("America/New_York");
  expect((await getWorkspaceSettings()).timezone).toBe("America/New_York");
});
