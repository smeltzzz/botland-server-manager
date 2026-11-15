// Read-only verification of the Electron binary produced by electron-builder.
// This intentionally never launches the executable or flips any fuses.
// Run after packaging: node scripts/verify-packaged-fuses.cjs [path/to/unpacked.exe]
const fs = require('node:fs/promises');
const path = require('node:path');
const { getCurrentFuseWire, FuseVersion, FuseV1Options } = require('@electron/fuses');

const requiredFuses = Object.freeze({
  runAsNode: { option: 'RunAsNode', enabled: false },
  enableCookieEncryption: { option: 'EnableCookieEncryption', enabled: true },
  enableNodeOptionsEnvironmentVariable: { option: 'EnableNodeOptionsEnvironmentVariable', enabled: false },
  enableNodeCliInspectArguments: { option: 'EnableNodeCliInspectArguments', enabled: false },
  enableEmbeddedAsarIntegrityValidation: { option: 'EnableEmbeddedAsarIntegrityValidation', enabled: true },
  onlyLoadAppFromAsar: { option: 'OnlyLoadAppFromAsar', enabled: true },
  grantFileProtocolExtraPrivileges: { option: 'GrantFileProtocolExtraPrivileges', enabled: false },
});
function stateName(state) {
  if (state === 48) return 'disabled';
  if (state === 49) return 'enabled';
  if (state === 114) return 'removed';
  if (state === 144) return 'inherited';
  return state === undefined ? 'missing' : `unknown (${state})`;
}
async function verifyPackagedFuses({ executable, packageFile = path.join(__dirname, '..', 'package.json') } = {}) {
  const metadata = JSON.parse(await fs.readFile(packageFile, 'utf8'));
  const expected = metadata.build?.electronFuses;
  for (const [name, policy] of Object.entries(requiredFuses)) {
    if (expected?.[name] !== policy.enabled) throw new Error(`build.electronFuses.${name} must explicitly be ${policy.enabled}.`);
  }
  const binary = path.resolve(executable || path.join(path.dirname(packageFile), metadata.build?.directories?.output || 'release', 'win-unpacked', `${metadata.build?.productName || ''}.exe`));
  const executableStat = await fs.stat(binary).catch(() => null);
  if (!executableStat?.isFile()) throw new Error(`Expected an unpacked Electron executable: ${binary}`);
  const packageStat = await fs.stat(path.join(path.dirname(binary), 'resources', 'app.asar')).catch(() => null);
  if (!packageStat?.isFile()) throw new Error('Expected resources/app.asar beside the unpacked executable; do not verify the NSIS installer or development Electron.');
  const actual = await getCurrentFuseWire(binary);
  if (actual.version !== FuseVersion.V1) throw new Error(`Unsupported Electron fuse version ${actual.version}; update the verifier before releasing.`);
  const checks = Object.entries(requiredFuses).map(([name, policy]) => {
    const index = FuseV1Options[policy.option];
    const wanted = expected[name] ? 49 : 48;
    const found = actual[index];
    return { name, expected: stateName(wanted), actual: stateName(found), passed: Number.isInteger(index) && found === wanted };
  });
  const failures = checks.filter(check => !check.passed);
  if (failures.length) throw new Error(`Packaged Electron fuse verification failed:\n${failures.map(check => `${check.name}: expected ${check.expected}, actual ${check.actual}`).join('\n')}`);
  return { executable: binary, version: actual.version, checks };
}

if (require.main === module) {
  verifyPackagedFuses({ executable: process.argv[2] }).then(result => {
    for (const check of result.checks) console.log(`${check.name}: expected ${check.expected}, actual ${check.actual}`);
    console.log(`Verified ${result.checks.length} packaged Electron fuses: ${result.executable}`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { verifyPackagedFuses, requiredFuses };
