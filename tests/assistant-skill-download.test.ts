import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sessionUser } = vi.hoisted(() => ({ sessionUser: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: sessionUser }));

import { GET, dynamic } from "@/app/api/assistant-skill/route";
import {
  buildPlatformSkillFile,
  fullSkillFile,
  loaderSkillFile,
  SKILL_FORMATS,
  SKILL_PLATFORMS,
} from "@/lib/agent/skillFile";

const origin = "https://growth.example.invalid/api/assistant-skill";
const date = new Date("2026-11-07T10:00:00Z");
const combinations = SKILL_PLATFORMS.flatMap((platform) =>
  SKILL_FORMATS.map((format) => ({ platform, format })),
);
const filenames = {
  claude: "SKILL.md",
  chatgpt: "nomeriq-growth-chatgpt-instructions.txt",
  gemini: "nomeriq-growth-gemini.md",
  hermes: "SKILL.md",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(date);
  // A session marker only: no credentials or database access in these download tests.
  sessionUser.mockResolvedValue({ id: "download-test-user" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe.each(combinations)("authenticated $platform / $format download", ({ platform, format }) => {
  it("returns the matching builder with an allowlisted attachment and no-store", async () => {
    const response = await GET(new Request(`${origin}?platform=${platform}&format=${format}`));
    expect(response.status).toBe(200);
    expect(sessionUser).toHaveBeenCalledTimes(1);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${filenames[platform]}"`);
    expect(response.headers.get("content-type")).toBe(
      platform === "chatgpt" ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8",
    );
    expect(await response.text()).toBe(buildPlatformSkillFile(platform, format, date));
  });

  it("requires a session even with valid download parameters", async () => {
    sessionUser.mockResolvedValue(null);
    const response = await GET(new Request(`${origin}?platform=${platform}&format=${format}`));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("content-disposition")).toBe(false);
    expect(await response.text()).not.toContain("get_instructions");
  });
});

describe("legacy downloads and strict parameter allowlists", () => {
  it("is dynamic and preserves the no-parameter Claude loader", async () => {
    expect(dynamic).toBe("force-dynamic");
    const response = await GET(new Request(origin));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="SKILL.md"');
    expect(await response.text()).toBe(loaderSkillFile());
  });

  it.each(SKILL_FORMATS)("preserves legacy format=%s without a platform", async (format) => {
    const response = await GET(new Request(`${origin}?format=${format}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(format === "full" ? fullSkillFile(date) : loaderSkillFile());
  });

  it.each(SKILL_PLATFORMS)("defaults %s to the loader", async (platform) => {
    const response = await GET(new Request(`${origin}?platform=${platform}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(buildPlatformSkillFile(platform, "loader", date));
  });

  it.each([
    "platform=unknown", "platform=Claude", "platform=", "platform=__proto__",
    "platform=..%2F..%2FSKILL.md", "platform=claude%0D%0AX-Injected%3Ayes",
    "format=unknown", "format=FULL", "format=", "format=__proto__",
    "format=full%22%3Bfilename%3Devil.txt", "platform=claude&format=full%0A",
    "platform=claude&platform=hermes", "format=loader&format=full",
  ])("rejects invalid/ambiguous parameters without reflecting them: %s", async (query) => {
    const response = await GET(new Request(`${origin}?${query}`));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("content-disposition")).toBe(false);
    expect(await response.text()).toBe("Invalid assistant skill platform or format.");
  });

  it("checks authentication before parameter validation", async () => {
    sessionUser.mockResolvedValue(null);
    const response = await GET(new Request(`${origin}?platform=unknown&format=unknown`));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
