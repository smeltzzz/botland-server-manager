const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { Worker, isMarkedAsUntransferable } = require('node:worker_threads');
const { zipSync } = require('fflate');
const { readModArchive, ARCHIVE_LIMITS } = require('../electron/mod-archive.cjs');
const { recipeFor } = require('../electron/botwarfare-recipes.cjs');
const { ArchiveCpu, readModArchiveAsync, planBotWarfareAsync } = require('../electron/archive-cpu.cjs');

const zip = (files, level = 6) => Buffer.from(zipSync(Object.fromEntries(
  Object.entries(files).map(([name, body]) => [name, Buffer.from(body)])), { level, mtime: new Date(1980, 0, 1) }));
const callbackName = 'maps/mp/gametypes/_callbacksetup.gsx';
const callback = 'CodeCallback_PlayerConnect()\n{\n\tself endon( "disconnect" );\n\t[[level.callbackPlayerConnect]]();\n}\n';
const cod4Root = 'Add to root of CoD4x server/mods/mp_bots/';
const mw2Root = 'Move files to root of MW2 folder/mods/mp_bots/';
const bo1Root = 'Move to root of Black Ops folder/mods/mp_bots/';
function clean(worker) {
  assert.equal(worker.threadId, -1, 'the worker is gone before the caller resumes');
  for (const event of ['message', 'messageerror', 'error', 'exit']) {
    assert.equal(worker.listenerCount(event), 0, `${event} listener removed`);
  }
}
function controlled() {
  const workers = [];
  class ControlledWorker extends EventEmitter {
    constructor(file, options) {
      super();
      this.file = file;
      this.options = options;
      this.threadId = workers.length + 1;
      this.terminations = 0;
      workers.push(this);
    }
    succeed(result = new Map([['file', Buffer.from('data')]])) { this.emit('message', { ok: true, result }); }
    terminate() {
      this.terminations++;
      this.threadId = -1;
      this.emit('exit', 0);
      return Promise.resolve(0);
    }
  }
  return { workers, Worker: ControlledWorker };
}
function realCpu(t) {
  const workers = [];
  class ObservedWorker extends Worker {
    constructor(...args) { super(...args); workers.push(this); }
  }
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); });
  return { cpu: new ArchiveCpu({ Worker: ObservedWorker }), workers };
}

test('real workers return Buffer-valued Maps identical to synchronous stored/deflated extraction without detaching input', async t => {
  const { cpu, workers } = realCpu(t);
  for (const level of [0, 6]) {
    const bytes = zip({ 'folder/': '', 'folder/data.bin': Buffer.from([0, 128, 255]), empty: '', text: 'payload'.repeat(5000) }, level);
    const envelope = Buffer.concat([Buffer.from('prefix'), bytes, Buffer.from('suffix')]);
    const view = envelope.subarray(6, envelope.length - 6);
    const before = Buffer.from(envelope);
    view[Symbol.iterator] = () => { throw new Error('Snapshotting must use a bounded native typed-array copy.'); };
    const limits = { maxInputBytes: bytes.length, maxEntries: 4, maxEntryBytes: 40_000, maxExtractedBytes: 40_000 };
    const result = await cpu.readModArchive(view, limits);
    assert.deepEqual(result, readModArchive(view, limits));
    assert.ok(result instanceof Map && [...result.values()].every(Buffer.isBuffer));
    assert.deepEqual(envelope, before, 'borrowed input, slab and adjacent bytes stay intact');
  }
  workers.forEach(clean);
});

test('all stable and source recipes, including reproducible CoD4 IWD construction, match the direct pure functions', async () => {
  const binary = Buffer.from([0, 1, 128, 255]);
  const cases = [
    ['cod4', 'stable', { [cod4Root + 'z_svr_bots.iwd']: binary, [cod4Root + callbackName]: callback,
      [cod4Root + 'scriptdata/waypoints/mp_crash_wp.csv']: 'waypoint' }],
    ['mw2', 'stable', { [mw2Root + 'z_svr_bots.iwd']: binary, [mw2Root + 'scriptdata/waypoints/mp_rust_wp.csv']: 'waypoint' }],
    ['mw3', 'stable', { 'z_svr_bots.iwd': binary }],
    ['waw', 'stable', { 'mp_bots/z_svr_bots.iwd': binary }],
    ['bo1', 'stable', { [bo1Root + 'description.txt']: 'description', [bo1Root + 'mod.ff']: binary, [bo1Root + 'mp_bots.iwd']: binary }],
    ['bo2', 'stable', { 'snapshot/scripts/mp/bots.gsc': binary, 'snapshot/scripts/mp/bots_adapter_pt6.gsc': 'adapter' }],
    ['cod4', 'development', { ['snapshot/' + callbackName]: callback, 'snapshot/maps/mp/bots/_bot.gsc': binary,
      'snapshot/scripts/mp/bots.gsc': 'bot'.repeat(500), 'snapshot/scripts/mp/bots_adapter_cod4x.gsc': 'adapter',
      'snapshot/scriptdata/waypoints/mp_crash_wp.csv': 'waypoint', 'snapshot/scripts/no.cfg': 'excluded' }],
    ['bo2', 'development', { 'scripts/mp/bots.gsc': binary, 'scripts/mp/bots_adapter_pt6.gsc': 'adapter' }],
  ];
  await Promise.all(cases.map(async ([id, channel, files]) => {
    const bytes = zip(files);
    const expected = recipeFor(id, channel, readModArchive(bytes));
    const result = await planBotWarfareAsync(id, channel, bytes);
    assert.deepEqual(result, expected, `${id}/${channel}`);
    assert.ok(result.files instanceof Map && [...result.files.values()].every(Buffer.isBuffer));
    if (id === 'cod4' && channel === 'development') {
      const iwd = result.files.get('z_svr_bots.iwd');
      assert.equal(iwd.readUInt16LE(10), 0, 'IWD DOS time is fixed, not worker wall clock');
      assert.equal(iwd.readUInt16LE(12), 33, 'IWD DOS date is 1980-01-01');
      assert.equal(readModArchive(iwd).has('scripts/no.cfg'), false);
    }
  }));
});

test('worker errors preserve ZIP validation and limits, sanitize recipe filenames, and clean up threads', async t => {
  const { cpu, workers } = realCpu(t);
  const bytes = zip({ file: 'payload' });
  const crc = Buffer.from(bytes);
  const central = crc.readUInt32LE(crc.length - 22 + 16);
  crc.writeUInt32LE(0, central + 16);
  crc.writeUInt32LE(0, 14);
  const zip64 = Buffer.from(bytes);
  zip64.writeUInt32LE(0xffffffff, central + 24);
  const bomb = zip({ bomb: Buffer.alloc(1024 * 1024, 65) });
  const bombCentral = bomb.readUInt32LE(bomb.length - 22 + 16);
  bomb.writeUInt32LE(16, bombCentral + 24);
  bomb.writeUInt32LE(16, 22);
  for (const [input, options, pattern] of [
    [Buffer.from('not zip'), {}, /Invalid ZIP archive/u],
    [zip({ '../private-path': 'payload' }), {}, /parent traversal/u],
    [crc, {}, /CRC mismatch/u],
    [zip64, {}, /ZIP64/u],
    [bomb, {}, /DEFLATE output/u],
    [bytes, { maxInputBytes: bytes.length - 1 }, /compressed input limit/u],
    [bytes, { maxEntries: 0 }, /entry count/u],
    [bytes, { maxEntryBytes: 1 }, /single entry/u],
    [bytes, { maxExtractedBytes: 1 }, /total extracted/u],
    [bytes, { maxEntryBytes: ARCHIVE_LIMITS.maxEntryBytes + 1 }, /maxEntryBytes/u],
  ]) await assert.rejects(cpu.readModArchive(input, options), pattern);
  await assert.rejects(cpu.planBotWarfare('bo2', 'development', zip({ 'secret-folder/scripts/mp/bots.gsc': 'bot' })), error => {
    assert.match(error.message, /missing required file/u);
    assert.equal(error.message.includes('secret-folder'), false);
    assert.equal(error.message.includes('archive-cpu-worker'), false);
    return true;
  });
  await assert.rejects(cpu.planBotWarfare('cod4', 'stable', zip({ [cod4Root + 'z_svr_bots.iwd']: 'mod', [cod4Root + callbackName]: 'wrong callback' })), /anchor mismatch/u);
  await assert.rejects(cpu.planBotWarfare('unknown', 'stable', bytes), /Unknown Bot Warfare game/u);
  await assert.rejects(cpu.planBotWarfare('mw3', 'unknown', bytes), /Unknown Bot Warfare channel/u);
  await assert.rejects(cpu.readModArchive('not bytes'), TypeError);
  workers.forEach(clean);
});

test('worker entry point refuses non-finite operations instead of executing caller code', async t => {
  const worker = new Worker(path.join(__dirname, '../electron/archive-cpu-worker.cjs'), {
    workerData: { operation: 'require', module: 'node:fs', code: 'throw new Error("do not execute")' }, execArgv: [],
  });
  t.after(() => worker.terminate());
  const [message] = await once(worker, 'message');
  assert.deepEqual(message, { ok: false, error: { name: 'Error', message: 'Unknown archive worker operation.' } });
  assert.equal('stack' in message.error, false);
  await worker.terminate();
});

test('bounded concurrency/queue take exact-size snapshots before waiting and drain after cleanup', async () => {
  const fake = controlled();
  const cpu = new ArchiveCpu({ Worker: fake.Worker, concurrency: 1, maxQueued: 1 });
  const a = zip({ a: 'one' });
  const b = zip({ b: 'two' });
  const before = Buffer.from(b);
  const first = cpu.readModArchive(a);
  const second = cpu.readModArchive(b);
  b.fill(0);
  const refused = cpu.readModArchive(a);
  await assert.rejects(refused, /queue is full/u);
  assert.equal(fake.workers.length, 1);
  const initial = fake.workers[0];
  assert.equal(path.basename(initial.file), 'archive-cpu-worker.cjs');
  assert.deepEqual(initial.options.execArgv, []);
  const snapshot = initial.options.workerData.input;
  assert.equal(snapshot.byteOffset, 0);
  assert.equal(snapshot.byteLength, snapshot.buffer.byteLength);
  assert.equal(isMarkedAsUntransferable(snapshot.buffer), false);
  assert.deepEqual(initial.options.transferList, [snapshot.buffer]);
  initial.succeed(readModArchive(initial.options.workerData.input));
  assert.deepEqual(await first, new Map([['a', Buffer.from('one')]]));
  clean(initial);
  assert.equal(initial.terminations, 1);
  assert.equal(fake.workers.length, 2);
  const queued = fake.workers[1];
  assert.deepEqual(Buffer.from(queued.options.workerData.input), before, 'queued bytes cannot change after checksum verification');
  queued.succeed(readModArchive(queued.options.workerData.input));
  assert.deepEqual(await second, new Map([['b', Buffer.from('two')]]));
  clean(queued);
});

test('two independent jobs can complete out of order without mixing results or exceeding the worker bound', async () => {
  const fake = controlled();
  const cpu = new ArchiveCpu({ Worker: fake.Worker, concurrency: 2, maxQueued: 2 });
  const jobs = Array.from({ length: 4 }, (_, i) => cpu.readModArchive(zip({ ['file' + i]: 'data' + i })));
  assert.equal(fake.workers.length, 2);
  fake.workers[1].succeed(readModArchive(fake.workers[1].options.workerData.input));
  assert.deepEqual(await jobs[1], new Map([['file1', Buffer.from('data1')]]));
  assert.equal(fake.workers.length, 3);
  assert.equal(fake.workers.filter(worker => worker.threadId !== -1).length, 2);
  fake.workers[2].succeed(readModArchive(fake.workers[2].options.workerData.input));
  assert.deepEqual(await jobs[2], new Map([['file2', Buffer.from('data2')]]));
  fake.workers[0].succeed(readModArchive(fake.workers[0].options.workerData.input));
  fake.workers[3].succeed(readModArchive(fake.workers[3].options.workerData.input));
  assert.deepEqual(await jobs[0], new Map([['file0', Buffer.from('data0')]]));
  assert.deepEqual(await jobs[3], new Map([['file3', Buffer.from('data3')]]));
  fake.workers.forEach(clean);
});

test('heartbeat turns continue while worker completion is gated, with no elapsed-time assertion', async t => {
  const fake = controlled();
  const cpu = new ArchiveCpu({ Worker: fake.Worker });
  const archiveModule = require('../electron/mod-archive.cjs');
  t.mock.method(archiveModule, 'readModArchive', () => { throw new Error('Extraction must not run on the main thread.'); });
  let settled = false;
  const work = cpu.readModArchive(zip({ file: 'payload' }));
  work.finally(() => { settled = true; }).catch(() => {});
  // Explicit message gating makes this deterministic even under a stalled or
  // heavily loaded CI scheduler; no "must finish within N ms" assumption.
  for (let turn = 0; turn < 4; turn++) {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
    assert.equal(fake.workers[0].threadId, 1);
  }
  fake.workers[0].succeed();
  await work;
  assert.equal(settled, true);
  clean(fake.workers[0]);
});

test('crashes, bad messages, output overflows and parser rejections all terminate workers and remove listeners', async () => {
  for (const [event, payload, pattern] of [
    ['error', new Error('C:\\private\\worker.cjs: raw worker exception'), /^Archive worker failed\.$/u],
    ['messageerror', new Error('private clone failure'), /^Archive worker failed\.$/u],
    ['exit', 17, /^Archive worker stopped before completing\.$/u],
    ['message', { ok: 'wrong' }, /^Invalid archive worker result\.$/u],
    ['message', { ok: true, result: new Map([['file', 'not bytes']]) }, /^Invalid archive worker result\.$/u],
    ['message', { ok: true, result: new Map([['file', Buffer.alloc(3)]]) }, /output limit/u],
    ['message', { ok: false, error: { name: 'TypeError', message: 'C:\\private\\file.zip', stack: 'secret' } }, /^Archive processing failed\.$/u],
    ['message', { ok: false, error: { name: 'Error', message: 'Invalid ZIP archive: CRC mismatch' } }, /CRC mismatch/u],
  ]) {
    const fake = controlled();
    const cpu = new ArchiveCpu({ Worker: fake.Worker });
    const work = cpu.readModArchive(zip({ file: 'x' }), { maxEntryBytes: 2 });
    fake.workers[0].emit(event, payload);
    await assert.rejects(work, error => { assert.match(error.message, pattern); return true; });
    clean(fake.workers[0]);
    assert.equal(fake.workers[0].terminations, 1);
  }
});

test('startup failure drains the next queued job, and worker timeout cleanup uses a deterministic fake clock', async t => {
  const fake = controlled();
  let attempts = 0;
  class StartFailure extends fake.Worker {
    constructor(...args) {
      if (!attempts++) throw new Error('C:\\private\\failed-worker.cjs');
      super(...args);
    }
  }
  const cpu = new ArchiveCpu({ Worker: StartFailure, concurrency: 1 });
  const first = cpu.readModArchive(zip({ file: 'x' }));
  const second = cpu.readModArchive(zip({ file: 'x' }));
  await assert.rejects(first, /^Error: Archive worker could not start\.$/u);
  fake.workers[0].succeed();
  await second;
  clean(fake.workers[0]);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timeout = cpu.readModArchive(zip({ file: 'x' }));
  t.mock.timers.tick(120_000);
  await assert.rejects(timeout, /Archive processing timed out/u);
  clean(fake.workers[1]);
  t.mock.timers.reset();
  // A timed-out job must not consume the queue's sole worker slot forever.
  const retry = cpu.readModArchive(zip({ file: 'x' }));
  fake.workers[2].succeed();
  await retry;
  clean(fake.workers[2]);
});

test('public async extraction keeps the default input cap before allocating a worker snapshot', async () => {
  const bytes = zip({ file: 'payload' });
  await assert.rejects(readModArchiveAsync(bytes, { maxInputBytes: 1 }), /compressed input limit/u);
  await assert.rejects(readModArchiveAsync(bytes, { maxEntries: Infinity }), RangeError);
  assert.throws(() => new ArchiveCpu({ concurrency: 3 }), /Invalid archive CPU/u);
  assert.throws(() => new ArchiveCpu({ maxQueued: 9 }), /Invalid archive CPU/u);
});
