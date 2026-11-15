const test = require('node:test');
const assert = require('node:assert/strict');
const { fakeMain, deferred, event, tick } = require('./main-shutdown-harness.cjs');

test('main drains session cleanup after stopAll has finished launch/process cleanup', async t => {
  const stop = deferred();
  const cleanup = deferred();
  let running = true;
  let pending = true;
  const calls = [];
  const manager = {
    hasRunning: () => running, hasModWork: () => false, hasPendingSessionCleanup: () => pending,
    stopAll: () => { calls.push('launch/process cleanup'); return stop.promise; },
    waitForSessionCleanup: () => { calls.push('session cleanup'); return cleanup.promise; },
  };
  const harness = await fakeMain(t, manager);
  const close = event();
  harness.win.handlers.close(close);
  assert.equal(close.prevented, true);
  assert.equal(harness.prompts.length, 1);
  assert.deepEqual(calls, ['launch/process cleanup']);
  running = false;
  stop.resolve();
  await tick();
  assert.deepEqual(calls, ['launch/process cleanup', 'session cleanup']);
  assert.equal(harness.quitCalls, 0, 'No final quit while a log tail/session file is still closing');
  const secondQuit = event();
  harness.handlers['before-quit'](secondQuit);
  assert.equal(secondQuit.prevented, true);
  pending = false;
  cleanup.resolve();
  await tick();
  assert.equal(harness.allowedQuits, 1);
  assert.deepEqual(harness.errors, []);
});

test('an apparently idle quit reserves shutdown and awaits full manager launch cleanup without prompting', async t => {
  const stopped = deferred();
  let guarded = false;
  let drained = false;
  const manager = {
    hasRunning: () => false, hasModWork: () => false, hasPendingSessionCleanup: () => false,
    stopAll: () => { guarded = true; return stopped.promise; },
    waitForSessionCleanup: async () => { drained = true; },
  };
  const harness = await fakeMain(t, manager);
  const quit = event();
  harness.handlers['before-quit'](quit);
  assert.equal(quit.prevented, true);
  assert.equal(guarded, true, 'The shutdown guard must be reserved before an unsaved-draft native prompt can run');
  assert.equal(harness.quitCalls, 0);
  assert.equal(harness.prompts.length, 0);
  stopped.resolve();
  await tick();
  assert.equal(drained, true);
  assert.equal(harness.allowedQuits, 1);
});

test('main rechecks installer work that appears during an awaited stop and cancels shutdown', async t => {
  const stop = deferred();
  let running = true;
  let installing = false;
  let cancelled = 0;
  const manager = {
    hasRunning: () => running, hasModWork: () => installing,
    stopAll: () => stop.promise, waitForSessionCleanup: async () => {},
    cancelShutdown: () => { cancelled++; },
  };
  const harness = await fakeMain(t, manager);
  harness.win.handlers.close(event());
  installing = true;
  running = false;
  stop.resolve();
  await tick();
  assert.equal(harness.quitCalls, 0);
  assert.equal(cancelled, 1);
  assert.match(harness.prompts.at(-1).message, /Wait for the Bot Warfare change/);
  assert.deepEqual(harness.errors, []);
});

test('idle before-quit waits for cleanup without a server prompt and rechecks late installer work', async t => {
  const cleanup = deferred();
  let installing = false;
  let cancelled = 0;
  const manager = {
    hasRunning: () => false, hasModWork: () => installing,
    hasPendingSessionCleanup: () => true, stopAll: async () => {},
    waitForSessionCleanup: () => cleanup.promise, cancelShutdown: () => { cancelled++; },
  };
  const harness = await fakeMain(t, manager);
  const quit = event();
  harness.handlers['before-quit'](quit);
  assert.equal(quit.prevented, true);
  assert.equal(harness.prompts.length, 0);
  installing = true;
  cleanup.resolve();
  await tick();
  assert.equal(harness.allowedQuits, 0);
  assert.equal(cancelled, 1);
  assert.equal(harness.prompts.length, 1);
  assert.equal(harness.prompts[0].type, 'info');
});

test('a completed stop confirmation cannot bypass a fresh installer check on final before-quit', async t => {
  let running = true;
  let installing = false;
  let cancelled = 0;
  const manager = {
    hasRunning: () => running, hasModWork: () => installing,
    stopAll: async () => { running = false; }, waitForSessionCleanup: async () => {},
    cancelShutdown: () => { cancelled++; },
  };
  const harness = await fakeMain(t, manager);
  harness.onQuit(() => { installing = true; });
  harness.win.handlers.close(event());
  await tick();
  assert.equal(harness.quitCalls, 1);
  assert.equal(harness.allowedQuits, 0);
  assert.equal(cancelled, 1, 'Re-entering the app after final quit was blocked must release its shutdown guard');
  assert.match(harness.prompts.at(-1).title, /change in progress/);
});

test('cleanup rejection keeps the app open and releases the shutdown guard', async t => {
  let cancelled = 0;
  const manager = {
    hasRunning: () => false, hasModWork: () => false, hasPendingSessionCleanup: () => true,
    stopAll: async () => {}, waitForSessionCleanup: async () => { throw new Error('Synthetic cleanup failure.'); },
    cancelShutdown: () => { cancelled++; },
  };
  const harness = await fakeMain(t, manager);
  harness.handlers['before-quit'](event());
  await tick();
  assert.equal(harness.quitCalls, 0);
  assert.equal(cancelled, 1);
  assert.deepEqual(harness.errors, [{ title: 'Could not close', message: 'Synthetic cleanup failure.' }]);
});
