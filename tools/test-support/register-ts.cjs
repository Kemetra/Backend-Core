/**
 * Test-only `require` hook: transpile `.ts` files with the repo's TypeScript
 * (no type check) so a child Node process can load app sources directly.
 * Used by `otlp-export-probe.cjs`; never loaded by production code.
 */
"use strict";

const fs = require("node:fs");
const ts = require("typescript");

const COMPILER_OPTIONS = {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
};

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: COMPILER_OPTIONS, fileName: filename });
  module._compile(outputText, filename);
};
