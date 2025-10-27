import { pool } from "./worker/worker_thread.mjs";

(async () => {
  // example for file
  let resultAdd;
  const task = { a: 5, b: 5 };
  resultAdd = await pool.runTaskScriptPath('./addition.mjs', task);
  console.log(resultAdd);


  // example for code execution
  const codef = (task) => {
    const results = [];

    function isPrime(n) {
      if (n < 2) return false;
      for (let i = 2; i * i <= n; i++) {
        if (n % i === 0) return false;
      }
      return true;
    }

    for (let i = 2; i < task.iterations; i++) {
      if (isPrime(i)) results.push(i);
    }

    return results.length;
  };
  const codes = pool.functionToString(codef, codef.name);
  resultAdd = await pool.runTaskScriptCode(codes, { iterations: 5_000_000 });
  console.log(resultAdd);

    
  // example for code execution with dependency
  const codefd = (data, dependencies) => {
    const results = [];

    function isPrime(n) {
      if (n < 2) return false;
      for (let i = 2; i * i <= n; i++) {
        if (n % i === 0) return false;
      }
      return true;
    }

    for (let i = 2; i < task.iterations; i++) {
      if (isPrime(i)) results.push(i);
    }

    const aTask = { a: results.length, b: 5 };
    return dependencies['addition'].default(aTask);
  };
  const codesd = pool.functionToString(codefd, codefd.name);
  const iterations = 5_000_000;
  const data = { iterations, dependencyPaths: ['./addition.mjs'] };
  resultAdd = await pool.runTaskScriptCode(codesd, data);
  console.log(resultAdd);
})();
