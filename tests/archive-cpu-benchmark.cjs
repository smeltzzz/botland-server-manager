// Manual, synthetic, in-memory benchmark (not a timing-sensitive unit test):
//   node tests/archive-cpu-benchmark.cjs
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { zipSync } = require('fflate');
const { readModArchive } = require('../electron/mod-archive.cjs');
const { readModArchiveAsync } = require('../electron/archive-cpu.cjs');

async function measure(label, extract, bytes, expected) {
  let pulses = 0;
  let last = performance.now();
  let maxGap = 0;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const timer = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
    pulses++;
    started();
  }, 1);
  try {
    await ready;
    const initialPulses = pulses;
    const start = performance.now();
    const files = await extract(bytes);
    const elapsedMs = performance.now() - start;
    const pulsesDuringWork = pulses - initialPulses;
    // Let the first post-work timer account for any main-thread blockage too.
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual([...files.keys()], ['payload.bin']);
    assert.ok(files.get('payload.bin').equals(expected));
    return { mode: label, elapsedMs: +elapsedMs.toFixed(2), heartbeatPulses: pulsesDuringWork,
      maxHeartbeatGapMs: +maxGap.toFixed(2) };
  } finally { clearInterval(timer); }
}

async function main() {
  const payload = Buffer.alloc(16 * 1024 * 1024, 65);
  const bytes = Buffer.from(zipSync({ 'payload.bin': payload }, { level: 6, mtime: new Date(1980, 0, 1) }));
  const results = [];
  for (let round = 1; round <= 3; round++) {
    results.push({ round, ...await measure('main-thread synchronous (before)', readModArchive, bytes, payload) });
    results.push({ round, ...await measure('worker-thread async (after)', readModArchiveAsync, bytes, payload) });
  }
  console.log(JSON.stringify({ node: process.version, extractedBytes: payload.length, compressedBytes: bytes.length,
    heartbeat: '1 ms interval; measurements only, no timing pass/fail threshold', results }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
