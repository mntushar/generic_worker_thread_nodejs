// @ts-nocheck
import { parentPort } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import path from 'path';

parentPort.on('message', async ({ scriptPath, scriptCode, task }) => {
  try {
    let result;

    if (scriptPath) {
      // resolve relative path to project root (process.cwd())
      const resolvedPath = path.isAbsolute(scriptPath)
        ? scriptPath
        : path.resolve(process.cwd(), scriptPath);

      // make file:// URL
      const scriptUrl = pathToFileURL(resolvedPath);

      // dynamic import
      const module = await import(scriptUrl.href);

      if (typeof module.default !== 'function') {
        throw new Error(`Script ${scriptPath} must export a default function`);
      }

      result = await module.default(task);
    }
    else if (scriptCode) {
      let dependencies = {};

      // add dependency module
      if (task.dependencyPaths) {
        for (const depPath of task.dependencyPaths) {
          const resolvedPath = path.isAbsolute(depPath)
            ? depPath
            : path.resolve(process.cwd(), depPath);
          const scriptUrl = pathToFileURL(resolvedPath);
          const module = await import(scriptUrl.href);
          const name = path.basename(depPath, path.extname(depPath));
          dependencies[name] = module;
        }
      }

      // Direct script code execution (no file)
      const asyncFn = new Function('task', 'dependencies', `
        return (async () => {
          ${scriptCode}
        })();
      `);
      result = await asyncFn(task, dependencies);
    }
    else {
      throw new Error('Neither scriptPath nor scriptCode provided');
    }

    if (result && typeof result.on === 'function') {
      result.on('data', (chunk) => parentPort.postMessage({ chunk }));
      result.on('end', () => parentPort.postMessage({ end: true }));
      result.on('error', (err) => parentPort.postMessage({ error: err.message }));
      result.end?.();
    } else {
      parentPort.postMessage({ result });
    }

  } catch (err) {
    parentPort.postMessage({ error: err.message });
  }
});
