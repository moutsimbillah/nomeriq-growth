import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInfo } from "@/lib/build-info";
import { GET } from "@/app/api/health/route";

// "Is my change actually live?" used to be unanswerable from outside: `git rev-parse HEAD` on the
// server proves only what is *checked out*, and an active service proves only that something is
// serving. A checkout that was never built is indistinguishable from a deployed one. The health
// payload therefore reports the commit the running bundle was compiled from — this suite pins that
// field's contract so a future edit cannot quietly drop or rename it.
describe("health route reports which build is serving", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("publishes the build's commit and build time", async () => {
    vi.stubEnv("BUILD_COMMIT", "abcdef1");
    vi.stubEnv("BUILD_TIME", "2026-11-08T07:25:51.204Z");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.service).toBe("nomeriq-growth");
    expect(body.database).toBe("reachable");
    // The field an operator reads to answer "is the deploy live?".
    expect(body.commit).toBe("abcdef1");
    expect(body.builtAt).toBe("2026-11-08T07:25:51.204Z");
  });

  it.each([undefined, ""])("reports unknown for an absent or empty stamp (%s)", async (value) => {
    vi.stubEnv("BUILD_COMMIT", value);
    vi.stubEnv("BUILD_TIME", value);
    expect(buildInfo()).toEqual({ commit: "unknown", builtAt: "unknown" });
    const body = await (await GET()).json();
    expect(body.commit).toBe("unknown");
    expect(body.builtAt).toBe("unknown");
  });

  it("keeps the operational fields the live checks depend on", async () => {
    // The deploy runbook's post-checks read these exact keys; adding the build identity must not
    // have displaced any of them.
    const body = await (await GET()).json();
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining(["ok", "service", "database", "sendMode", "commit", "builtAt", "timestamp"]),
    );
    // Send mode is the safety switch reported to the outside world; it must stay readable and must
    // not be replaced by the build identity.
    expect(body.sendMode).toBe("sandbox");
  });
});
