import fs from "node:fs/promises";
import childProcess from "node:child_process";
import { vi } from "vitest";

/** Synthetic OS facts only; the production verifier and capability issuer remain real. */
export function mockScheduledBackupFacts() {
  const originalStat = fs.lstat.bind(fs);
  const originalRealpath = fs.realpath.bind(fs);
  const originalExec = childProcess.execFileSync;
  const uidDescriptor = Object.getOwnPropertyDescriptor(process, "getuid");
  const stamps = new Map<string, number>();
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 1000 });
  const stat = vi.spyOn(fs, "lstat").mockImplementation((async (file: Parameters<typeof fs.lstat>[0], ...args: unknown[]) => {
    if (!String(file).startsWith("/var/backups/growth/deploy-")) return originalStat(file, ...args as []);
    const key = String(file);
    if (!stamps.has(key)) stamps.set(key, Date.now() - 1000);
    return { mode: 0o100600, size: 2048, nlink: 1, uid: 1000, ino: 1, mtimeMs: stamps.get(key) };
  }) as typeof fs.lstat);
  const realpath = vi.spyOn(fs, "realpath").mockImplementation((async (file: Parameters<typeof fs.realpath>[0], ...args: unknown[]) => {
    if (String(file).startsWith("/var/backups/growth/deploy-")) return String(file);
    return originalRealpath(file, ...args as []);
  }) as typeof fs.realpath);
  const exec = vi.spyOn(childProcess, "execFileSync").mockImplementation(((file: string, ...args: unknown[]) => {
    if (file === "pg_restore") return Array.from({ length: 50 }, (_, i) => `x TABLE DATA ${i}`).join("\n");
    return Reflect.apply(originalExec, childProcess, [file, ...args]);
  }) as typeof childProcess.execFileSync);
  return () => {
    stat.mockRestore(); realpath.mockRestore(); exec.mockRestore();
    if (uidDescriptor) Object.defineProperty(process, "getuid", uidDescriptor);
    else Reflect.deleteProperty(process, "getuid");
  };
}
