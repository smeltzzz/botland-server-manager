// Synthetic Electron/real-ASAR smoke; no renderer, ServerManager, settings,
// downloads, executables or game folders are loaded.
//   node_modules/.bin/electron.cmd tests/archive-cpu-electron.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { app } = require('electron');
const { createPackage } = require('@electron/asar');
const { zipSync } = require('fflate');
const { isolateSmokeProfile } = require('./smoke-harness.cjs');

const profile = isolateSmokeProfile(app, 'botland-archive-cpu-smoke');
const workers = [];
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  try {
    const source = path.join(profile, 'source');
    const archive = path.join(profile, 'archive-cpu-fixture.asar');
    await fs.mkdir(path.join(source, 'electron'), { recursive: true });
    for (const file of ['archive-cpu.cjs', 'archive-cpu-worker.cjs', 'archive-cpu-protocol.cjs', 'mod-archive.cjs', 'botwarfare-recipes.cjs']) {
      await fs.copyFile(path.join(__dirname, '../electron', file), path.join(source, 'electron', file));
    }
    await fs.cp(path.join(__dirname, '../node_modules/fflate'), path.join(source, 'node_modules/fflate'), { recursive: true });
    await createPackage(source, archive);
    await fs.rm(source, { recursive: true }); // No unpacked fixture can mask an ASAR failure.
    const { ArchiveCpu } = require(path.join(archive, 'electron/archive-cpu.cjs'));
    class ObservedWorker extends Worker {
      constructor(file, options) {
        assert.ok(file.startsWith(archive + path.sep));
        assert.equal(path.basename(file), 'archive-cpu-worker.cjs');
        super(file, options);
        workers.push(this);
      }
    }
    const cpu = new ArchiveCpu({ Worker: ObservedWorker });
    const content = Buffer.alloc(64 * 1024, 65);
    const bytes = Buffer.from(zipSync({ 'payload.bin': content, empty: Buffer.alloc(0) }));
    const files = await cpu.readModArchive(bytes);
    assert.ok(files instanceof Map && [...files.values()].every(Buffer.isBuffer));
    assert.deepEqual(files.get('payload.bin'), content);
    await assert.rejects(cpu.readModArchive(Buffer.from('invalid zip')), /Invalid ZIP archive/u);
    const callback = 'CodeCallback_PlayerConnect()\n{\n\tself endon( "disconnect" );\n\t[[level.callbackPlayerConnect]]();\n}\n';
    const tree = { 'snapshot/maps/mp/gametypes/_callbacksetup.gsx': Buffer.from(callback),
      'snapshot/maps/mp/bots/_bot.gsc': content,
      'snapshot/scripts/mp/bots.gsc': Buffer.from('synthetic bot'),
      'snapshot/scripts/mp/bots_adapter_cod4x.gsc': Buffer.from('synthetic adapter') };
    const plan = await cpu.planBotWarfare('cod4', 'development', Buffer.from(zipSync(tree)));
    assert.equal(plan.target, 'game');
    assert.ok(plan.files instanceof Map && [...plan.files.values()].every(Buffer.isBuffer));
    assert.equal(plan.patches.length, 2);
    const built = await cpu.readModArchive(plan.files.get('z_svr_bots.iwd'));
    assert.deepEqual(built.get('maps/mp/bots/_bot.gsc'), content);
    for (const worker of workers) {
      assert.equal(worker.threadId, -1);
      for (const event of ['message', 'messageerror', 'error', 'exit']) assert.equal(worker.listenerCount(event), 0);
    }
    console.log(`Archive CPU Electron ${process.versions.electron}/Node ${process.versions.node} real-ASAR smoke passed (4 cleaned workers).`);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}).then(() => app.quit(), error => { console.error(error); app.exit(1); });
