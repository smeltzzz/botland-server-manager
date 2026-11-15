const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
const { verifyPackagedFuses, requiredFuses } = require('../scripts/verify-packaged-fuses.cjs');

async function fixture(t) {
  const temporaryRoot = path.join(process.env.LOCALAPPDATA || os.tmpdir(), ...(process.env.LOCALAPPDATA ? ['Temp', 'opencode'] : ['opencode']));
  await fs.mkdir(temporaryRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(temporaryRoot, 'botland-fuse-verification-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const executable = path.join(dir, 'release', 'win-unpacked', 'Synthetic.exe');
  await fs.mkdir(path.join(path.dirname(executable), 'resources'), { recursive: true });
  await fs.writeFile(path.join(path.dirname(executable), 'resources', 'app.asar'), 'synthetic package presence');
  const metadata = { build: { productName: 'Synthetic', directories: { output: 'release' }, electronFuses: Object.fromEntries(Object.entries(requiredFuses).map(([name, policy]) => [name, policy.enabled])) } };
  const packageFile = path.join(dir, 'package.json');
  await fs.writeFile(packageFile, JSON.stringify(metadata));
  // A synthetic fuse wire, not an executable. Use the installed official reader
  // against bytes on disk rather than mocking its return value/config metadata.
  const wire = Buffer.from([1, 8, 48, 49, 48, 48, 49, 49, 48, 48]);
  const binary = Buffer.concat([Buffer.from('synthetic binary dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), wire]);
  await fs.writeFile(executable, binary);
  return { executable, packageFile, metadata, binary, wireStart: binary.length - 8 };
}

test('fuse verifier reads every required actual fuse and leaves binary bytes unchanged', async t => {
  const { executable, packageFile, binary } = await fixture(t);
  const result = await verifyPackagedFuses({ packageFile });
  assert.equal(result.executable, executable);
  assert.equal(result.checks.length, 7);
  assert.ok(result.checks.every(check => check.passed && check.expected === check.actual));
  assert.equal((await getCurrentFuseWire(executable))[FuseV1Options.RunAsNode], 48);
  assert.deepEqual(await fs.readFile(executable), binary, 'verification must never flip fuses');
});

test('fuse verifier fails for every mismatched, missing, removed or inherited required fuse', async t => {
  const fixtureData = await fixture(t);
  const { executable, packageFile, binary, wireStart } = fixtureData;
  for (const [name, policy] of Object.entries(requiredFuses)) {
    for (const state of [policy.enabled ? 48 : 49, 114, 144]) {
      const altered = Buffer.from(binary);
      altered[wireStart + FuseV1Options[policy.option]] = state;
      await fs.writeFile(executable, altered);
      await assert.rejects(verifyPackagedFuses({ executable, packageFile }), new RegExp(`${name}: expected .*actual`));
    }
  }
  const short = Buffer.from(binary.subarray(0, binary.length - 1));
  short[wireStart - 1] = 7;
  await fs.writeFile(executable, short);
  await assert.rejects(verifyPackagedFuses({ executable, packageFile }), /grantFileProtocolExtraPrivileges: expected disabled, actual missing/);
});

test('fuse verifier refuses weakened expected policy, unsupported versions and non-packaged inputs', async t => {
  const { executable, packageFile, metadata, binary, wireStart } = await fixture(t);
  metadata.build.electronFuses.runAsNode = true;
  await fs.writeFile(packageFile, JSON.stringify(metadata));
  await assert.rejects(verifyPackagedFuses({ executable, packageFile }), /runAsNode must explicitly be false/);
  metadata.build.electronFuses.runAsNode = false;
  await fs.writeFile(packageFile, JSON.stringify(metadata));
  const unsupported = Buffer.from(binary);
  unsupported[wireStart - 2] = 2;
  await fs.writeFile(executable, unsupported);
  await assert.rejects(verifyPackagedFuses({ executable, packageFile }), /Unsupported Electron fuse version/);
  await fs.writeFile(executable, 'not an Electron binary');
  await assert.rejects(verifyPackagedFuses({ executable, packageFile }), /Could not find sentinel/);
  await fs.rm(path.join(path.dirname(executable), 'resources', 'app.asar'));
  await assert.rejects(verifyPackagedFuses({ executable, packageFile }), /ENOENT|app.asar/);
});
