import { parentPort, workerData } from 'node:worker_threads';
import { BackupRunIntegrityError, prepareDatabase } from './backup.js';

const { source, file } = workerData as { source: string; file: string };
try {
  await prepareDatabase(source, file, phase => parentPort?.postMessage(phase));
} catch (error) {
  if (!(error instanceof BackupRunIntegrityError)) throw error;
  parentPort?.postMessage({ inconsistentRunId: error.runId });
}
