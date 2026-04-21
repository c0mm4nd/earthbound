import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = readFileSync(new URL("../src/lib/bridge-normalization.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
});

const commonJsModule = { exports: {} };
new Script(outputText, { filename: "bridge-normalization.cjs" }).runInNewContext({
  exports: commonJsModule.exports,
  module: commonJsModule,
  require,
});

const { normalizeBridgeQuoteResponse, normalizeBuildUserStepsResponse } = commonJsModule.exports;

const quoteResponse = normalizeBridgeQuoteResponse({
  quotes: [
    {
      id: "quote-1",
      srcAmount: "100",
      dstAmount: "90",
      routeSteps: [{ type: "bridge" }],
    },
  ],
});

assert.equal(JSON.stringify(quoteResponse.quotes[0].userSteps), "[]");

const buildResponse = normalizeBuildUserStepsResponse({});

assert.equal(JSON.stringify(buildResponse.userSteps), "[]");
