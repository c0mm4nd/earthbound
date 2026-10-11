import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import ts from 'typescript';
const require = createRequire(import.meta.url);
export function createLoader(overrides = {}, globals = {}) {
  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const source = readFileSync(new URL(`../../src/lib/${name}.ts`, import.meta.url), 'utf8');
    const cjs = { exports: {} };
    new Script(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { filename: `${name}.cjs` }).runInNewContext({
      module: cjs, exports: cjs.exports, Buffer, URLSearchParams, AbortSignal, fetch, setTimeout, Uint8Array, atob, btoa, ...globals,
      require: id => overrides[id] ?? (id.startsWith('./') ? load(id.slice(2)) : id.startsWith('@/lib/') ? load(id.slice(6)) : require(id)),
    });
    modules.set(name, cjs.exports);
    return cjs.exports;
  }
  return load;
}
