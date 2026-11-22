import os from 'node:os';
import path from 'node:path';

export const PORT = Number(process.env.PORT ?? 3000);
export const HOST = process.env.HOST ?? 'localhost';
export const DATA_DIR = process.env.DATA_DIR ?? path.join(os.homedir(), '.canitruntests');
export const BODY_LIMIT = 50 * 1024 * 1024;
export const HTTP_TIMEOUT_MS = 30_000; // default for single shots and pm.sendRequest
export const SCRIPT_TIMEOUT_MS = 5000; // per script, including its timers and pm.sendRequest calls
export const FLOW_MAX_NODE_RUNS = 100; // default per flow run
export { FLOW_MAX_NODE_RUNS_CAP } from '../shared/flow';
