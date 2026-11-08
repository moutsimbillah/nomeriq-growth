import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const git = vi.hoisted(() => ({ execSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execSync: git.execSync }));

beforeEach(() => {
  vi.resetModules();
  git.execSync.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("Next build identity configuration", () => {
  it("provides the trimmed git commit and an ISO build timestamp for compilation", async () => {
    git.execSync.mockReturnValue(Buffer.from("abcdef1\n"));
    const { default: config } = await import("../next.config");
    expect(config.env?.BUILD_COMMIT).toBe("abcdef1");
    expect(config.env?.BUILD_TIME).toEqual(expect.any(String));
    const time = String(config.env?.BUILD_TIME);
    expect(new Date(time).toISOString()).toBe(time);
    expect(git.execSync).toHaveBeenCalledWith("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    });
  });

  it("keeps the config loadable when git is unavailable", async () => {
    git.execSync.mockImplementation(() => { throw new Error("git unavailable in fixture"); });
    const { default: config } = await import("../next.config");
    expect(config.env?.BUILD_COMMIT).toBe("unknown");
    expect(config.env?.BUILD_TIME).toEqual(expect.any(String));
  });

  it("does not publish an empty git result as an identity", async () => {
    git.execSync.mockReturnValue(Buffer.from(" \n"));
    const { default: config } = await import("../next.config");
    expect(config.env?.BUILD_COMMIT).toBe("unknown");
  });
});
