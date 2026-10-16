import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

export function loadModule(file, globals = {}, cache = new Map()) {
  const filename = resolve(file);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  vm.runInNewContext(code, {
    console, URL, crypto, setTimeout, clearTimeout, __MONKEYS_BUILD_ID__: 'test-build', ...globals, module, exports: module.exports,
    require: name => name.startsWith('.')
      ? loadModule(resolve(dirname(filename), `${name}.ts`), globals, cache)
      : createRequire(import.meta.url)(name),
  }, { filename });
  return module.exports;
}
