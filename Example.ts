import { WorkerPool } from "./worker_thread";

const size = 1e9;
const pool = new WorkerPool();

result = await pool.executeTask<number>(
    (data: number) => {
        let sum = 0;
        for (let i = 0; i < data; i++) sum += i;
        return sum;
    },
    [size]
);
