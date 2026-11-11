import { readFileSync } from "node:fs";
import ts from "typescript";

/**
 * Compiles a real TSX component to CommonJS so a test can render it with React.
 *
 * Next preserves JSX, which Vitest's repo-wide transform does not execute; the tests that assert
 * on rendered markup therefore compile the shipped source themselves. This uses the TypeScript
 * compiler in-process rather than esbuild's service worker, because the worker spawns a child
 * process with piped stdio, which confined environments refuse. Same input, same emitted
 * `react/jsx-runtime` require, no external binary.
 */
export function compileTsx(file: string): string {
  const result = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: file,
  });
  const error = result.diagnostics?.find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (error) {
    throw new Error(`${file} did not compile: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`);
  }
  return result.outputText;
}

/** Evaluates compiled CommonJS and returns its exports. `require` is the caller's resolver. */
export function evaluate<T>(code: string, require: (id: string) => unknown): T {
  const module = { exports: {} as Record<string, unknown> };
  new Function("require", "module", "exports", code)(require, module, module.exports);
  return module.exports as T;
}