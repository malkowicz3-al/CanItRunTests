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
// load runs (stage 3); exceeding them in the run body is a 400
export const MAX_VUS = 200;
export const MAX_ITERATIONS = 1_000_000; // per VU
export const MAX_TOTAL_ITERATIONS = 10_000_000; // iterations x VUs
export const MAX_DURATION_MIN = 30; // a load run is stopped with status 'limit' after this
export const LOAD_TICK_MS = 100; // stats interval of load workers and of flow.stats
export const SAMPLES_PER_TICK = 4; // nodes whose samples one flow.stats may carry (the final one carries all)
export const LOAD_SAMPLE_MS = 1000; // flow.stats carries a node's samples (up to 64 KB each) at most this often, except the final one
// per-call list of a load run (memory only, served by GET /api/flows/:id/run/calls)
export const CALLS_KEPT = 200; // newest calls kept per node
export const FAILED_CALLS_KEPT = 100; // newest failed calls kept per node
export const CALL_SAMPLE_LIMIT = 16 * 1024; // body and log cut of a call's sample
