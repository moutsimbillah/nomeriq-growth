import { afterEach, expect, it, vi } from "vitest";
import { keepAliveJson } from "@/lib/ai/keep-alive-json";

afterEach(() => vi.useRealTimers());

it("keeps a slow suggestion alive with JSON whitespace and disables proxy buffering", async () => {
  vi.useFakeTimers();
  let resolve!: (value: unknown) => void;
  const result = new Promise(r => { resolve = r; });
  const response = keepAliveJson(() => result, async () => ({ ok: false }));
  expect(response.headers.get("X-Accel-Buffering")).toBe("no");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let raw = decoder.decode((await reader.read()).value);
  expect(raw).toBe("\n");
  await vi.advanceTimersByTimeAsync(15_000);
  raw += decoder.decode((await reader.read()).value);
  expect(raw).toBe("\n\n");
  resolve({ ok: true, data: { body: "Synthetic reply" } });
  await vi.advanceTimersByTimeAsync(0);
  raw += decoder.decode((await reader.read()).value);
  expect(JSON.parse(raw)).toEqual({ ok: true, data: { body: "Synthetic reply" } });
  expect((await reader.read()).done).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("turns errors into the existing safe JSON failure envelope", async () => {
  const response = keepAliveJson(async () => { throw new Error("private synthetic"); }, async () => ({ ok: false, error: "Please retry." }));
  expect(await response.json()).toEqual({ ok: false, error: "Please retry." });
});

it("cleans up the heartbeat when the browser disconnects", async () => {
  vi.useFakeTimers();
  const response = keepAliveJson(() => new Promise(() => undefined), async () => ({}));
  await response.body!.cancel();
  expect(vi.getTimerCount()).toBe(0);
});
