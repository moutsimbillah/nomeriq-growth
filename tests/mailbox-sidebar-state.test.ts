/**
 * The sidebar's mailbox line tells the truth about what is connected.
 *
 * THE DEFECT THIS COVERS
 * The sidebar said "No mailbox connected" while `moutsim@nomeriq.com` was connected and holding every
 * imported thread. The cause was the label being derived from the workspace *sending* default alone,
 * and the import's own mailbox can never be that default (it belongs to the leads the import pinned to
 * it). A truthful line names the state instead: the sending mailbox, an import-only mailbox, or a
 * mailbox that is not the sender yet.
 */

import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { describeMailbox } from "@/lib/email/accounts";

const importMailbox = (overrides: Partial<Parameters<typeof describeMailbox>[0][number]> = {}) => ({
  emailAddress: "moutsim@nomeriq.com",
  provider: "ionos",
  isDefault: false,
  neverDefault: true,
  ...overrides,
});

it("names an import-only mailbox for what it is instead of saying nothing is connected", () => {
  const state = describeMailbox([importMailbox()]);
  expect(state.kind).toBe("import_only");
  expect(state.label).toBe("moutsim@nomeriq.com — import only · no sending mailbox");
});

it("shows the sending mailbox when one is set", () => {
  const state = describeMailbox([
    importMailbox(),
    { emailAddress: "moutsim@nomeriq.info", provider: "smtp_imap", isDefault: true, neverDefault: false },
  ]);
  expect(state.kind).toBe("default");
  expect(state.label).toBe("moutsim@nomeriq.info");
});

it("marks a sandbox sender as sandbox", () => {
  const state = describeMailbox([
    { emailAddress: "sandbox@example.test", provider: "sandbox", isDefault: true, neverDefault: false },
  ]);
  expect(state.label).toBe("sandbox@example.test · sandbox");
});

it("never lets the import mailbox be presented as the sender", () => {
  // A row that is both flagged default and import-only is still not a sending mailbox: the import
  // mailbox belongs to its pinned leads only.
  const state = describeMailbox([importMailbox({ isDefault: true })]);
  expect(state.kind).toBe("import_only");
  expect(state.label).toContain("no sending mailbox");
});

it("says a connected mailbox is not the sender yet rather than claiming none is connected", () => {
  const state = describeMailbox([
    { emailAddress: "founder@example.test", provider: "smtp_imap", isDefault: false, neverDefault: false },
  ]);
  expect(state.kind).toBe("no_default");
  expect(state.label).toBe("founder@example.test — not the sending mailbox yet");
});

it("says nothing is connected only when nothing is", () => {
  expect(describeMailbox([])).toEqual({ kind: "none", label: null });
});

it("is what the app chrome actually renders", () => {
  // The chrome keeps its own empty-state wording for the genuine no-mailbox case; the layout must feed
  // it the real state rather than the sending default alone.
  expect(readFileSync("src/components/app-chrome.tsx", "utf8")).toContain(
    '{mailboxLabel || "No mailbox connected"}',
  );
  expect(readFileSync("src/app/(app)/layout.tsx", "utf8")).toContain("getMailboxSidebarState()");
});
