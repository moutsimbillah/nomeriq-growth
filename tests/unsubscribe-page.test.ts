import React from "react";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { compileTsx } from "./helpers/tsx-loader";

const nativeRequire = createRequire(import.meta.url);
const code = compileTsx("src/app/unsubscribe/[token]/page.tsx");

function loadPage(inspect: () => Promise<unknown>) {
  const module = { exports: {} as Record<string, unknown> };
  const require = (id: string): unknown => {
    if (id === "@/components/logo") {
      return { LogoMark: () => React.createElement("span", null, "Growth") };
    }
    if (id === "@/components/unsubscribe-form") {
      return {
        UnsubscribeForm: ({ token }: { token: string }) =>
          React.createElement("button", { type: "button", "data-confirm-token": token }, "Confirm unsubscribe"),
      };
    }
    if (id === "@/lib/services/suppressions") return { inspectUnsubscribeToken: inspect };
    return nativeRequire(id);
  };
  new Function("require", "module", "exports", code)(require, module, module.exports);
  return module.exports.default as (input: { params: Promise<{ token: string }> }) => Promise<React.ReactElement>;
}

describe("unsubscribe page", () => {
  it("does not offer confirmation for invalid or already-unsubscribed tokens", async () => {
    const cases = [
      { status: "invalid", heading: "This link is not valid." },
      { status: "already_unsubscribed", heading: "This address is already unsubscribed." },
    ] as const;
    for (const expected of cases) {
      const Page = loadPage(async () => expected);
      const element = await Page({ params: Promise.resolve({ token: "token-value-long-enough-for-test" }) });
      const html = renderToStaticMarkup(element);
      expect(html).toContain(expected.heading);
      expect(html).not.toContain("Confirm unsubscribe");
    }
  });

  it("keeps the confirmation action available if token preflight cannot reach the database", async () => {
    const Page = loadPage(async () => { throw new Error("temporary database outage"); });
    const token = "real-token-value-long-enough-to-check";
    const element = await Page({ params: Promise.resolve({ token }) });
    const html = renderToStaticMarkup(element);
    expect(html).toContain("Confirm unsubscribe");
    expect(html).toContain(`data-confirm-token=\"${token}\"`);
  });
});
