const { parentPort, workerData } = require('node:worker_threads');
const { readModArchive, archiveLimits } = require('./mod-archive.cjs');
const { recipeFor } = require('./botwarfare-recipes.cjs');
const { archiveError, transferFiles } = require('./archive-cpu-protocol.cjs');

// A one-shot, CPU-only worker: no filenames, downloads, filesystem writes,
// callbacks, dynamic modules or executable code are accepted from the caller.
// worker_threads works in packaged Electron with the RunAsNode fuse disabled.
if (!parentPort) throw new Error('Archive worker requires a worker thread.');
try {
  if (!workerData || !['read-archive', 'botwarfare-plan'].includes(workerData.operation)) {
    throw new Error('Unknown archive worker operation.');
  }
  const limits = archiveLimits(workerData.limits);
  const entries = readModArchive(workerData.input, limits);
  let result;
  let transferList;
  if (workerData.operation === 'read-archive') {
    ({ files: result, transferList } = transferFiles(entries, limits));
  } else {
    const plan = recipeFor(workerData.id, workerData.channel, entries);
    const transferred = transferFiles(plan.files, limits);
    result = { ...plan, files: transferred.files };
    transferList = transferred.transferList;
  }
  parentPort.postMessage({ ok: true, result }, transferList);
} catch (error) {
  parentPort.postMessage({ ok: false, error: archiveError(error) });
} finally {
  parentPort.close();
}
