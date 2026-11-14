const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

async function demoManager() {
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
  return module.exports.createDemoManager();
}

test('browser preview enforces BO1 firewall and duplicate-start safeguards', async () => {
  const manager = await demoManager();
  await assert.rejects(manager.start('bo1'), /verified public inbound UDP firewall rule/u);
  await manager.firewallApply('bo1');
  await manager.start('bo1');
  await assert.rejects(manager.start('bo1'), /already starting or running/u);
  await manager.stop('bo1');
});

test('browser preview keeps firewall rules on the applied port, including running-to-next-start drift', async () => {
  const manager = await demoManager();
  await manager.firewallApply('bo1');
  await manager.start('bo1');
  await manager.saveOptions('bo1', { port: 30123 });
  assert.equal((await manager.firewallStatus('bo1')).state, 'any');
  assert.equal((await manager.firewallStatus('bo1')).port, 28961);
  await manager.stop('bo1');
  assert.equal((await manager.firewallStatus('bo1')).state, 'drift');
  assert.equal((await manager.firewallStatus('bo1')).port, 30123);
  await assert.rejects(manager.start('bo1'), /verified public inbound UDP firewall rule/);
  await manager.firewallApply('bo1');
  assert.equal((await manager.firewallStatus('bo1')).state, 'any');
  await manager.start('bo1');
  await manager.stop('bo1');
});
