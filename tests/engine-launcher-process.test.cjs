const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// Intercept only this module's child-process import; never launch a real EXE.
const target = require.resolve('../electron/engine-update.cjs');
const originalLoad = Module._load;
let nextChild;
let spawnOptions;
let runLauncher;
try {
  Module._load = function (request, parent, isMain) {
    if (request === 'node:child_process' && parent?.filename === target) {
      return { spawn: (_file, _args, options) => { spawnOptions = options; return nextChild; } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  ({ runLauncher } = require('../electron/engine-update.cjs'));
} finally { Module._load = originalLoad; }

function child() {
  const process = new EventEmitter();
  process.killCalls = 0;
  process.kill = () => { process.killCalls++; return true; };
  nextChild = process;
  return process;
}

test('official launcher runs visibly without a game-launch shell or redirected pipes', async () => {
  const process = child();
  const work = runLauncher('C:\\Example\\iw4x-launcher.exe', ['--skip-launch'], { cwd: 'C:\\Example', timeout: 2000 });
  assert.deepEqual(spawnOptions, { cwd: 'C:\\Example', windowsHide: false, stdio: 'ignore', shell: false });
  process.emit('close', 0);
  await work;
  assert.equal(process.killCalls, 0);
});

test('a timed-out launcher holds the file-change reservation until its process actually closes', async () => {
  const process = child();
  let settled = false;
  const work = runLauncher('C:\\Example\\iw4x-launcher.exe', [], { cwd: 'C:\\Example', timeout: 15 });
  work.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(process.killCalls, 1);
    assert.equal(settled, false, 'no game work may resume while the updater remains alive');
  } finally { process.emit('close', null); }
  await assert.rejects(work, /timed out/u);
  assert.equal(settled, true);
});

test('a post-spawn process error retains the file-change reservation until close', async () => {
  const process = child();
  let settled = false;
  const work = runLauncher('C:\\Example\\iw4x-launcher.exe', [], { cwd: 'C:\\Example', timeout: 2000 });
  work.then(() => { settled = true; }, () => { settled = true; });
  process.emit('spawn');
  process.emit('error', new Error('kill failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'a live launcher must keep other file changes and quit blocked');
  process.emit('close', null);
  await assert.rejects(work, /process reported an error/u);
  assert.equal(settled, true);
});
