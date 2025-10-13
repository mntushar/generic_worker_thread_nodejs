import { Worker } from 'worker_threads';
import os from 'os';


//worker script 
const workerScript = `
const { parentPort } = require('worker_threads');
const os = require('os');
const MAX_CACHE_SIZE = Math.min(1000, 50 + (os.cpus().length * 8)); // Prevent unbounded growth
const moduleCache = {};
const funcCache = new Map(); // Use Map for LRU-friendly operations

function addToCache(cache, key, value) {
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey); // Simple FIFO eviction
  }
  cache.set(key, value);
}

parentPort.on('message', async (task) => {
  const { funcString, taskId, args, dependencies = {}, modules = {} } = task;
  try {
    const importedModules = {};
    for (const [key, moduleName] of Object.entries(modules)) {
      if (!moduleCache[moduleName]) {
        moduleCache[moduleName] = require(moduleName);
      }
      importedModules[key] = moduleCache[moduleName];
    }
    
    const dependencyFuncs = {};
    for (const [key, value] of Object.entries(dependencies)) {
      if (!funcCache.has(value)) {
        addToCache(funcCache, value, eval('(' + value + ')'));
      }
      dependencyFuncs[key] = funcCache.get(value);
    }
    
    const allDependencies = { ...importedModules, ...dependencyFuncs };
    const dependencyNames = Object.keys(allDependencies);
    const dependencyValues = Object.values(allDependencies);
    
    if (!funcCache.has(funcString)) {
      const fn = new Function(...dependencyNames, 
        'return (' + funcString + ')(...arguments);'
      );
      addToCache(funcCache, funcString, fn);
    }
    const fn = funcCache.get(funcString);
    
    const result = await fn(...dependencyValues, ...args);
    parentPort.postMessage({ taskId, result });
  } catch (err) {
    const error = err.stack || err.message || err.toString();
    parentPort.postMessage({ taskId, error });
  }
});
`;

interface Task<T = any> {
  func: (...args: any[]) => T | Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
  taskId: number;
  args: any[];
  dependencies?: Record<string, string>;
  modules?: Record<string, string>;
}

interface TaskMessage<T = any> {
  taskId: number;
  result?: T;
  error?: string;
}

export class WorkerPool {
  private size: number;
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private taskQueue: Task[] = [];
  private tasks = new Map<number, { resolve: (value: any) => void; reject: (reason?: any) => void }>();
  private taskIdCounter = 0;
  private isTerminating = false;
  private activeTasks = 0;

  constructor(
    isMultipleThread?: boolean | null | undefined,
    size: number = isMultipleThread ? os.cpus().length : 1
  ) {
    if (typeof size !== 'number' || size < 1) {
      throw new Error('Pool size must be a positive integer');
    }
    this.size = size;

    for (let i = 0; i < size; i++) {
      this.addWorker();
    }
  }

  private addWorker() {
    const worker = new Worker(workerScript, { eval: true });

    worker.on('message', (msg: TaskMessage) => {
      if (msg.error) {
        console.error(`Worker error: ${msg.error}`);
      }
      this.handleResult(worker, msg);
    });

    worker.on('error', (err: Error) => {
      console.error(`Worker error: ${err.stack || err.message}`);
      this.handleWorkerFailure(worker);
    });

    worker.on('exit', (code: number) => {
      this.handleWorkerFailure(worker);
    });

    this.workers.push(worker);
    this.idleWorkers.push(worker);
  }

  private handleResult(worker: Worker, message: TaskMessage) {
    const { taskId, result, error } = message;

    if (!this.tasks.has(taskId)) {
      console.warn(`Unknown task ID: ${taskId}`);
      this.idleWorkers.push(worker);
      return;
    }

    const { resolve, reject } = this.tasks.get(taskId)!;
    this.tasks.delete(taskId);
    this.activeTasks--;
    this.idleWorkers.push(worker);

    if (error) {
      reject(new Error(error));
    } else {
      resolve(result);
    }

    this.processQueue();
  }

  private handleWorkerFailure(worker: Worker) {
    const index = this.workers.indexOf(worker);
    if (index !== -1) this.workers.splice(index, 1);

    const idleIndex = this.idleWorkers.indexOf(worker);
    if (idleIndex !== -1) this.idleWorkers.splice(idleIndex, 1);

    if (!this.isTerminating && this.workers.length < this.size) {
      this.addWorker();
    }
  }

  private processQueue() {
    if (this.taskQueue.length === 0 || this.idleWorkers.length === 0) return;

    const worker = this.idleWorkers.shift()!;
    const { func, resolve, reject, taskId, args, dependencies, modules } = this.taskQueue.shift()!;

    this.tasks.set(taskId, { resolve, reject });
    this.activeTasks++;

    try {
      worker.postMessage({
        funcString: func.toString(),
        taskId,
        args,
        dependencies,
        modules
      });
    } catch (err: any) {
      this.idleWorkers.push(worker);
      this.tasks.delete(taskId);
      reject(new Error(`Failed to post task to worker: ${err.message}`));
    }
  }

  runTask<T = any>(
    func: (...args: any[]) => T | Promise<T>,
    args: any[] = [],
    dependencies: Record<string, any> = {}
  ): Promise<T> {
    if (this.isTerminating) {
      return Promise.reject(new Error('Worker pool is terminating'));
    }

    if (typeof func !== 'function') {
      return Promise.reject(new Error('Task must be a function'));
    }

    // Separate modules and function dependencies
    const stringDependencies: Record<string, string> = {};
    const modules: Record<string, string> = {};

    for (const [key, value] of Object.entries(dependencies)) {
      if (typeof value === 'function') {
        stringDependencies[key] = value.toString();
      } else if (typeof value === 'string') {
        // If it's a string, treat it as a module name
        modules[key] = value;
      } else if (typeof value === 'object' && value !== null) {
        // For objects/modules, user should pass the module name as string
        throw new Error(
          `Dependency "${key}" is an object/module. Pass the module name as a string instead. ` +
          `Example: { ${key}: 'fs' }`
        );
      } else {
        throw new Error(`Dependency "${key}" must be a function or module name string. Got ${typeof value}`);
      }
    }

    return new Promise<T>((resolve, reject) => {
      const taskId = ++this.taskIdCounter;
      this.taskQueue.push({
        func,
        resolve,
        reject,
        taskId,
        args,
        dependencies: stringDependencies,
        modules
      });
      this.processQueue();
    });
  }

  private async drain() {
    while (this.activeTasks > 0 || this.taskQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  async terminate() {
    if (this.isTerminating) return;
    this.isTerminating = true;

    for (const task of this.taskQueue) {
      task.reject(new Error('Worker pool terminated before task execution'));
    }
    this.taskQueue = [];

    await this.drain();

    await Promise.all(this.workers.map(worker => worker.terminate()));

    this.workers = [];
    this.idleWorkers = [];
    this.tasks.clear();
  }

  async executeTask<T>(
    func: (...args: any[]) => T | Promise<T>,
    args: any[] = [],
    dependencies: Record<string, any> = {}
  ): Promise<T> {
    try {
      return await this.runTask(func, args, dependencies);
    } catch (err) {
      throw err;
    } finally {
      await this.terminate();
    }
  }
}
