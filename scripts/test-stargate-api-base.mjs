import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/lib/layerzero.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
});

const commonJsModule = { exports: {} };
const calls = [];
const mockFetch = async (url, init) => {
  calls.push({ url, init });

  return {
    text: async () => JSON.stringify({ ok: true }),
  };
};

new Script(outputText, { filename: "layerzero.cjs" }).runInNewContext({
  exports: commonJsModule.exports,
  module: commonJsModule,
  require,
  fetch: mockFetch,
  process,
  Headers,
});

const { fetchStargateApiJson } = commonJsModule.exports;

await fetchStargateApiJson("/quotes", {
  method: "POST",
  body: JSON.stringify({ hello: "world" }),
});

assert.equal(calls.length, 1);
assert.equal(calls[0].url, "https://stargate.finance/api/vt/v1/quotes");
assert.equal(calls[0].init.headers.get("Referer"), "https://stargate.finance/");
