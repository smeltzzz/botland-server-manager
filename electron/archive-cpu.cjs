const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { archiveLimits } = require('./mod-archive.cjs');
const { restoreError, restoreFiles, restorePlan } = require('./archive-cpu-protocol.cjs');

const WORKERS = 2;
const QUEUED = 8;
const TIMEOUT_MS = 120_000;
const workerFile = path.join(__dirname, 'archive-cpu-worker.cjs');
const games = new Set(['cod4', 'mw2', 'mw3', 'waw', 'bo1', 'bo2']);

class ArchiveCpu {
  #queue = [];
  #active = 0;
  // Worker injection and lower concurrency/queue limits are offline test seams.
  // Production uses a shared bounded queue, not an unbounded worker per caller.
  constructor({ Worker: WorkerClass = Worker, concurrency = WORKERS, maxQueued = QUEUED, timeoutMs = TIMEOUT_MS } = {}) {
    if (typeof WorkerClass !== 'function' || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > WORKERS ||
        !Number.isSafeInteger(maxQueued) || maxQueued < 0 || maxQueued > QUEUED ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) {
      throw new TypeError('Invalid archive CPU worker options.');
    }
    this.Worker = WorkerClass;
    this.concurrency = concurrency;
    this.maxQueued = maxQueued;
    this.timeoutMs = timeoutMs;
  }
  readModArchive(input, options = {}) {
    return this.#submit('read-archive', input, options);
  }
  async planBotWarfare(id, channel, input) {
    if (!games.has(id)) throw new Error('Unknown Bot Warfare game.');
    if (!['stable', 'development'].includes(channel)) throw new Error('Unknown Bot Warfare channel.');
    return this.#submit('botwarfare-plan', input, {}, { id, channel });
  }
  async #submit(operation, input, options, extra = {}) {
    if (!(input instanceof Uint8Array)) throw new TypeError('ZIP input must be a Buffer or Uint8Array');
    const limits = archiveLimits(options);
    if (input.byteLength > limits.maxInputBytes) throw new Error('Invalid ZIP archive: compressed input limit exceeded');
    if (this.#active >= this.concurrency && this.#queue.length >= this.maxQueued) {
      throw new Error('Archive processing queue is full. Retry after the current install finishes.');
    }
    // Snapshot borrowed bytes before the first await. In particular, a download
    // already SHA-256-checked by the installer must not change while queued. A
    // dedicated backing store avoids detaching callers' Buffers or Node slabs.
    const bytes = new Uint8Array(input.byteLength);
    bytes.set(input);
    return new Promise((resolve, reject) => {
      this.#queue.push({ request: { operation, input: bytes, limits, ...extra }, resolve, reject });
      this.#drain();
    });
  }
  #drain() {
    while (this.#active < this.concurrency && this.#queue.length) {
      const job = this.#queue.shift();
      this.#active++;
      this.#run(job.request).then(
        value => this.#complete(job, null, value),
        error => this.#complete(job, error),
      );
    }
  }
  #complete(job, error, value) {
    this.#active--;
    this.#drain();
    if (error) job.reject(error);
    else job.resolve(value);
  }
  async #run(request) {
    let worker;
    try {
      // A fixed local entry point, never eval or child_process.fork. No Electron
      // globals are required in the worker, including in app.asar builds.
      worker = new this.Worker(workerFile, { workerData: request, transferList: [request.input.buffer], execArgv: [] });
    } catch {
      throw new Error('Archive worker could not start.');
    }
    let timer;
    let onMessage;
    let onError;
    let onExit;
    try {
      return await new Promise((resolve, reject) => {
        onMessage = message => {
          try {
            if (message?.ok === false) throw restoreError(message.error);
            if (message?.ok !== true) throw new Error('Invalid archive worker result.');
            resolve(request.operation === 'read-archive'
              ? restoreFiles(message.result, request.limits) : restorePlan(message.result, request.limits));
          } catch (error) { reject(error); }
        };
        onError = () => reject(new Error('Archive worker failed.'));
        onExit = () => reject(new Error('Archive worker stopped before completing.'));
        worker.once('message', onMessage);
        worker.once('messageerror', onError);
        worker.once('error', onError);
        worker.once('exit', onExit);
        timer = setTimeout(() => reject(new Error('Archive processing timed out.')), this.timeoutMs);
        timer.unref?.();
      });
    } finally {
      clearTimeout(timer);
      // Do not release the caller's install/busy reservation until the thread
      // is gone. Every success, parser error, crash and timeout takes this path.
      try { await worker.terminate(); }
      catch { throw new Error('Archive worker could not stop.'); }
      finally {
        worker.removeListener('message', onMessage);
        worker.removeListener('messageerror', onError);
        worker.removeListener('error', onError);
        worker.removeListener('exit', onExit);
      }
    }
  }
}

const cpu = new ArchiveCpu();
const readModArchiveAsync = (input, options) => cpu.readModArchive(input, options);
const planBotWarfareAsync = (id, channel, input) => cpu.planBotWarfare(id, channel, input);

module.exports = { ArchiveCpu, readModArchiveAsync, planBotWarfareAsync };
