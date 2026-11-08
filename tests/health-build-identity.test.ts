import { describe, expect, it } from "vitest";
import { buildInfo } from "@/lib/build-info";
import { GET } from "@/app/api/health/route";

// "Is my change actually live?" used to be unanswerable from outside: `git rev-parse HEAD` on the
// server proves only what is *checked out*, and an active service proves only that something is
// serving. A checkout that was never built is indistinguishable from a deployed one. The health
// payload therefore reports the commit the running bundle was compiled from — this suite pins that
// field's contract so a future edit cannot quietly drop or rename it.
describe("health route reports which build is serving", () => {
  it("publishes the build's commit and build time", async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.service).toBe("nomeriq-growth");
    expect(body.database).toBe("reachable");
    // The field an operator reads to answer "is the deploy live?".
    expect(body).toHaveProperty("commit");
    expect(body).toHaveProperty("builtAt");
    expect(typeof body.commit).toBe("string");
    expect(typeof body.builtAt).toBe("string");
    expect(body.commit).not.toBe("");
  });

  it("never reports an empty commit, so a missing build stamp cannot read as a valid one", () => {
    // Unbuilt trees, CI without git and local runs all report "unknown" — a value an operator can
    // distinguish from a real short SHA. An empty string would silently look like a successful
    // read that carries no information.
    const info = buildInfo();
    expect(info.commit).toBeTruthy();
    expect(info.builtAt).toBeTruthy();
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
