import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Browser-local timestamps leak the visitor's clock into a workspace that agrees
 * on one zone. These three surfaces must format in the workspace timezone.
 */

const INTEGRATIONS = readFileSync("src/components/settings/integrations.tsx", "utf8");
const EMAIL_ACCOUNTS = readFileSync("src/components/settings/email-accounts.tsx", "utf8");
const RESEARCH = readFileSync("src/components/research-activity.tsx", "utf8");

const ZONED = /toLocaleString\(\s*"en-GB"\s*,\s*\{\s*timeZone:\s*timezone\s*\}\s*\)/;

/** True when an `en-GB` locale call closes without a timezone option. */
function hasUnzonedLocaleCall(source: string): boolean {
  return source
    .split('toLocaleString("en-GB"')
    .slice(1)
    .some((rest) => !/^\s*,\s*\{[^}]*timeZone/.test(rest));
}

describe("workspace timezone reaches every timestamp", () => {
  it("formats the API key last-used time in the workspace zone", () => {
    expect(hasUnzonedLocaleCall(INTEGRATIONS)).toBe(false);
    expect(INTEGRATIONS).toMatch(ZONED);
  });

  it("formats the mailbox last-sync time in the workspace zone", () => {
    expect(EMAIL_ACCOUNTS).toMatch(/useWorkspaceTimezone/);
    expect(hasUnzonedLocaleCall(EMAIL_ACCOUNTS)).toBe(false);
    expect(EMAIL_ACCOUNTS).toMatch(ZONED);
  });

  it("formats activity clocks through clockTime(value, timezone)", () => {
    expect(RESEARCH).toMatch(/useWorkspaceTimezone/);
    expect(RESEARCH).toMatch(/timeZone:\s*timezone/);
    expect(RESEARCH).toMatch(/clockTime\(item\.at,\s*timezone\)/);
  });
});
