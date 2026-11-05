import { describe, expect, it } from "vitest";

import { assertDryRunTarget, databaseNameOf } from "@/lib/import/gateTarget";

/**
 * The guard that would have caught the run that pointed at live: rewriting the host and port of the live
 * connection string left the database name as `growth`, and every assertion passed against the wrong data.
 */

describe("the dry-run target guard", () => {
  it("refuses the live database by name", () => {
    expect(() => assertDryRunTarget("postgresql://u:p@127.0.0.1:15432/growth")).toThrow(/live database/);
  });

  it("refuses an unnamed database, a trailing slash and a malformed string", () => {
    expect(() => assertDryRunTarget("postgresql://u:p@127.0.0.1:15432/")).toThrow(/no database named/);
    expect(() => assertDryRunTarget("postgresql://u:p@127.0.0.1:15432")).toThrow(/no database named/);
    expect(() => assertDryRunTarget("not a url at all")).toThrow(/no database named/);
  });

  it("refuses nothing at all", () => {
    expect(() => assertDryRunTarget(undefined)).toThrow(/no connection string/);
    expect(() => assertDryRunTarget("   ")).toThrow(/no connection string/);
  });

  it("refuses any other database, so a typo cannot pass", () => {
    expect(() => assertDryRunTarget("postgresql://u:p@127.0.0.1:15432/growth_import_dryru")).toThrow(/expected growth_import_dryrun/);
    expect(() => assertDryRunTarget("postgresql://u:p@127.0.0.1:15432/postgres")).toThrow(/expected growth_import_dryrun/);
  });

  it("accepts the copy, whatever the host, port or parameters", () => {
    expect(assertDryRunTarget("postgresql://u:p@127.0.0.1:15432/growth_import_dryrun")).toContain("growth_import_dryrun");
    expect(assertDryRunTarget("postgresql://u:p@127.0.0.1:15432/growth_import_dryrun?sslmode=require")).toContain("growth_import_dryrun");
    expect(databaseNameOf("postgresql://u:p@127.0.0.1:15432/growth_import_dryrun")).toBe("growth_import_dryrun");
  });
});
