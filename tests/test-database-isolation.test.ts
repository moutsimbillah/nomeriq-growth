import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { transpileModule, ModuleKind } from "typescript";
import { expect, it } from "vitest";

it("the real test setup chooses a fresh isolated DB even when Windows reuses the exact PID", () => {
  const source = readFileSync("tests/setup.ts", "utf8");
  const compiled = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText;
  const require = createRequire(import.meta.url);
  function setup() {
    const process = { pid: 12345, env: {} as Record<string, string> };
    runInNewContext(compiled, { require, process, exports: {} });
    return process.env;
  }
  const first = setup(), second = setup();
  expect(first.PGLITE_DIR).toMatch(/^\.data\/test-vitest-12345-[0-9a-f-]{36}$/);
  expect(second.PGLITE_DIR).toMatch(/^\.data\/test-vitest-12345-[0-9a-f-]{36}$/);
  expect(first.PGLITE_DIR).not.toBe(second.PGLITE_DIR);
  for (const env of [first, second]) {
    expect(env.DATABASE_URL).toBe("");
    expect(env.AUTO_MIGRATE).toBe("true");
    expect(env.EMAIL_DELIVERY_MODE).toBe("sandbox");
    expect(env.AI_PROVIDER).toBe("none");
  }
});
