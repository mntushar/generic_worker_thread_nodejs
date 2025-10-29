// @ts-nocheck
import { AsyncResource } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const kTaskInfo = Symbol('kTaskInfo');
const kWorkerFreedEvent = Symbol('kWorkerFreedEvent');

class WorkerPoolTaskInfo extends AsyncResource {
  constructor(resolve, reject) {
    super('WorkerPoolTaskInfo');
    this.resolve = resolve;
    this.reject = reject;
  }

  done(err, result) {
    if (err) this.runInAsyncScope(this.reject, null, err);
    else this.runInAsyncScope(this.resolve, null, result);
    this.emitDestroy(); // `TaskInfo`s are used only once.
  }
}

export default class WorkerPool extends EventEmitter {
  #numThreads;
  #workers = [];
  #freeWorkers = [];
  #tasks = [];

  constructor(numThreads) {
    super();
    this.#numThreads = numThreads;
    this.#workers = [];
    this.#freeWorkers = [];
    this.#tasks = [];

    for (let i = 0; i < numThreads; i++) this.#addNewWorker();

    // Any time the kWorkerFreedEvent is emitted, dispatch
    // the next task pending in the queue, if any.
    this.on(kWorkerFreedEvent, () => {
      if (this.#tasks.length > 0) {
        const { scriptPath, task, resolve, reject } = this.#tasks.shift();
        this.#runTaskInternal(scriptPath, task, resolve, reject);
      }
    });
  }

  #addNewWorker() {
    const workerFile = path.resolve(__dirname, 'worker_wrapper.mjs');
    const worker = new Worker(workerFile, { execArgv: [], argv: [] });

    worker.on('message', (result) => {
      // In case of success: Call the callback that was passed to `runTask`,
      // remove the `TaskInfo` associated with the Worker, and mark it as free
      // again.
      if (result.chunk) {
        this.emit('stream-chunk', result.chunk, worker);
      } else if (result.end) {
        if (worker[kTaskInfo]) worker[kTaskInfo].done(null, null);
        worker[kTaskInfo] = null;
        this.#freeWorkers.push(worker);
        this.emit(kWorkerFreedEvent, worker);
        this.emit('stream-task-ended', worker);
      } else if (result.error) {
        if (worker[kTaskInfo]) worker[kTaskInfo].done(new Error(result.error), null);
        worker[kTaskInfo] = null;
        this.#workers.splice(this.#workers.indexOf(worker), 1);
        this.#addNewWorker();
      } else {
        if (worker[kTaskInfo]) worker[kTaskInfo].done(null, result.result);
        worker[kTaskInfo] = null;
        this.#freeWorkers.push(worker);
        this.emit(kWorkerFreedEvent, worker);
      }

    });

    worker.on('error', (err) => {
      // In case of an uncaught exception: Call the callback that was passed to
      // `runTask` with the error.
      if (worker[kTaskInfo]) worker[kTaskInfo].done(err, null);
      else this.emit('error', err);

      // Remove the worker from the list and start a new Worker to replace the
      // current one.
      this.#workers.splice(this.#workers.indexOf(worker), 1);
      this.#addNewWorker();
    });

    this.#workers.push(worker);
    this.#freeWorkers.push(worker);
    this.emit(kWorkerFreedEvent);
  }

  async runTaskScriptPath(scriptPath, task) {
    return new Promise((resolve, reject) => {
      // No free threads, wait until a worker thread becomes free.
      if (this.#freeWorkers.length === 0) {
        this.#tasks.push({ scriptPath, task, resolve, reject });
        return;
      }
      this.#runTaskInternal({ scriptPath: scriptPath }, task, resolve, reject);
    });
  }

  async runTaskScriptCode(scriptCode, task) {
    return new Promise((resolve, reject) => {
      // No free threads, wait until a worker thread becomes free.
      if (this.#freeWorkers.length === 0) {
        this.#tasks.push({ scriptCode, task, resolve, reject });
        return;
      }
      this.#runTaskInternal({ scriptCode: scriptCode }, task, resolve, reject);
    });
  }

  // task run by event
  #runTaskInternal(options, task, resolve, reject) {
    const worker = this.#freeWorkers.pop();
    worker[kTaskInfo] = new WorkerPoolTaskInfo(resolve, reject);
    worker.postMessage({ scriptPath: options?.scriptPath, scriptCode: options?.scriptCode, task });
  }


  close() {
    for (const worker of this.#workers) worker.terminate();
  }

  functionToString(funtionObject, returnFuntionName) {
    return `
        const ${returnFuntionName} = ${funtionObject.toString()};
        return ${returnFuntionName}(task, dependencies);
      `;
  }
}
