// Runs one compile off the main thread and sends the model back as bytes.

import { parentPort, workerData } from 'node:worker_threads';
import { compile } from './compile.js';

try {
  const { model, report } = await compile(workerData.rows, workerData.options);
  const bytes = model.toBytes();
  parentPort.postMessage({ bytes, report }, [bytes.buffer]);
} catch (err) {
  parentPort.postMessage({ error: { name: err?.name ?? 'Error', message: String(err?.message ?? err) } });
}
