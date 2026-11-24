import { parentPort, workerData } from 'node:worker_threads';
import { ApiError } from '../store.js';
import { Catalog } from './database.js';

export type CatalogDeletion = { sourceId: number } | { confirmation: string };
export type CatalogDeletionResult = { files: { key: string }[]; deleted: number };
export type DeleteSourceReply = CatalogDeletionResult
  | { message: string; statusCode?: number; errcode?: number };

const { database, projectId, operation } = workerData as { database: string; projectId: number; operation: CatalogDeletion };
const catalog = new Catalog(database, 'confirmation' in operation ? 5_000 : undefined);
let reply: DeleteSourceReply;
try {
  reply = 'confirmation' in operation ? catalog.clearProject(projectId, operation.confirmation)
    : { files: catalog.deleteSource(projectId, operation.sourceId), deleted: 1 };
} catch (error) {
  reply = {
    message: (error as Error).message,
    statusCode: error instanceof ApiError ? error.statusCode : undefined,
    errcode: (error as { errcode?: number }).errcode,
  };
} finally {
  catalog.close();
}
parentPort?.postMessage(reply);
parentPort?.close();
