import { Worker } from 'worker_threads';
import os from 'os';

// Updated worker script to handle arguments
const workerScript = `
const { parentPort } = require('worker_threads');

parentPort.on('message', async (task) => {
  const { funcString, taskId, args } = task;  // Added args parameter
  try {
    const fn = new Function('return ' + funcString)();
    const result = await fn(...args);  // Pass arguments to function
    parentPort.postMessage({ taskId, result });
  } catch (err) {
    const error = err.stack || err.message || err.toString();
    parentPort.postMessage({ taskId, error });
  }
});

process.on('uncaughtException', (err) => {
  const error = err.stack || err.message || err.toString();
  parentPort.postMessage({ error: \`Uncaught: \${error}\` });
});
`;

interface Task<T = any> {
    func: (...args: any[]) => T | Promise<T>;  // Updated function signature
    resolve: (value: T) => void;
    reject: (reason?: any) => void;
    taskId: number;
    args: any[];
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
        size: number = isMultipleThread ? os.cpus().length : 1) {
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

        // Replace worker unless pool is terminating
        if (!this.isTerminating && this.workers.length < this.size) {
            this.addWorker();
        }
    }

    private processQueue() {
        if (this.taskQueue.length === 0 || this.idleWorkers.length === 0) return;

        const worker = this.idleWorkers.shift()!;
        const { func, resolve, reject, taskId, args } = this.taskQueue.shift()!;

        this.tasks.set(taskId, { resolve, reject });
        this.activeTasks++;

        try {
            worker.postMessage({
                funcString: func.toString(),
                taskId,
                args,
            });
        } catch (err: any) {
            this.idleWorkers.push(worker);
            this.tasks.delete(taskId);
            reject(new Error(`Failed to post task to worker: ${err.message}`));
        }
    }

    runTask<T = any>(func: (...args: any[]) => T | Promise<T>, args: any[] = []): Promise<T> {
        if (this.isTerminating) {
            return Promise.reject(new Error('Worker pool is terminating'));
        }

        if (typeof func !== 'function') {
            return Promise.reject(new Error('Task must be a function'));
        }

        return new Promise<T>((resolve, reject) => {
            const taskId = ++this.taskIdCounter;
            this.taskQueue.push({ func, resolve, reject, taskId, args });
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

        // Reject pending tasks
        for (const task of this.taskQueue) {
            task.reject(new Error('Worker pool terminated before task execution'));
        }
        this.taskQueue = [];

        // Wait for active tasks to complete
        await this.drain();

        // Terminate all workers
        await Promise.all(this.workers.map(worker => worker.terminate()));

        // Clean up references
        this.workers = [];
        this.idleWorkers = [];
        this.tasks.clear();
    }

    // Fixed executeTask to handle arguments
    async executeTask<T>(func: (...args: any[]) => T | Promise<T>, args: any[] = []): Promise<T> {
        try {
            return await this.runTask(func, args);
        } catch (err) {
            throw err;
        } finally {
            await this.terminate();
        }
    }
}