import { WorkerPool } from "./worker_thread";
import { anotherHelper, doSomeThing } from "./dependency";

const size = 1e9;
const pool = new WorkerPool();

// example without dependency
(async () => {
    result = await pool.executeTask<number>(
        (data: number) => {
            let sum = 0;
            for (let i = 0; i < data; i++) sum += i;
            return sum;
        },
        [size]
    );
    console.log("Worker result:", result);
}).();


// example with dependency
(async () => {
    const size = 1e9;
    const pool = new WorkerPool();
    const result = await pool.executeTask<number>(
        (doSomeThing, anotherHelper, data) => {
            let sum = 0;
            for (let i = 0; i < data; i++) sum += i;
            const processed = doSomeThing(sum);
            return anotherHelper(processed);
        },
        [size], // Regular arguments
        { doSomeThing, anotherHelper } // Dependencies to inject
    );

    console.log("Worker result:", result);
})();
