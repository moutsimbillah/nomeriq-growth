import { expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

it("031 adds enabled identity toggles without changing saved text and is safe to rerun", async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE workspace_settings (
      id text PRIMARY KEY, sender_signature text NOT NULL, postal_address text NOT NULL
    ); INSERT INTO workspace_settings VALUES ('default', 'Regards, Fixture Founder', '1 Fixture Street');`);
    const sql = readFileSync("src/db/migrations/031_email_identity_toggles.sql", "utf8");
    await db.exec(sql);
    const first = await db.query("SELECT * FROM workspace_settings");
    expect(first.rows).toEqual([{
      id: "default", sender_signature: "Regards, Fixture Founder", postal_address: "1 Fixture Street",
      sender_signature_enabled: true, postal_address_enabled: true,
    }]);
    await db.exec("UPDATE workspace_settings SET sender_signature_enabled=false, postal_address_enabled=false");
    const disabled = await db.query("SELECT * FROM workspace_settings");
    await db.exec(sql);
    expect((await db.query("SELECT * FROM workspace_settings")).rows).toEqual(disabled.rows);
    expect((await db.query("SELECT count(*)::int AS n FROM workspace_settings")).rows).toEqual([{ n: 1 }]);
  } finally {
    await db.close();
  }
});
