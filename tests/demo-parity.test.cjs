const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

test('browser preview enforces BO1 firewall and duplicate-start safeguards', async () => {
  const source = await fs.readFile(path.join(__dirname, '..', 'src', 'demo.ts'), 'utf8');
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const context = {
    module, exports: module.exports,
    document: { documentElement: { dataset: {} } },
    structuredClone,
  };
  vm.runInNewContext(javascript, context, { filename: 'src/demo.ts' });
  const manager = module.exports.createDemoManager();

  await assert.rejects(manager.start('bo1'), /verified public inbound UDP firewall rule/u);
  await manager.firewallApply('bo1');
  await manager.start('bo1');
  await assert.rejects(manager.start('bo1'), /already starting or running/u);
  await manager.stop('bo1');
});
