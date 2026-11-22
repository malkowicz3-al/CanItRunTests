import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { HTTP_TIMEOUT_MS, SCRIPT_TIMEOUT_MS } from './config';
import type { FlowInput } from './core/flow';
import { prepare } from './core/prepare';
import type { RunInput } from './core/run';
import type { FlowJobDone, FlowJobEvent, RunJobResult, WorkerMessage } from './worker';

export type RunOutput = Extract<RunJobResult, { result: unknown }>;
export type FlowDone = Omit<FlowJobDone, 'jobId'>;
export interface FlowHandle { done: Promise<FlowDone>; cancel(): void }
export interface RunPool {
  run(input: RunInput): Promise<RunOutput>;
  runFlow(input: FlowInput, onEvent: (e: FlowJobEvent) => void): FlowHandle;
  close(): Promise<void>;
}

// HTTP_TIMEOUT_MS covers the main request with all its redirects; pm.sendRequest time is inside each script's limit
function hardTimeout(input: RunInput): number {
  const p = prepare(input.collection, input.requestId, input.override);
  return SCRIPT_TIMEOUT_MS * (p.pre.length + p.test.length) + HTTP_TIMEOUT_MS + 5000;
}

interface Job { ok: (m: WorkerMessage) => void; ko: (e: Error) => void; timer?: NodeJS.Timeout; onEvent?: (e: FlowJobEvent) => void }

/** One long-lived worker; a job that exceeds its hard timeout (e.g. a loop after `await`) kills it, the next job spawns a new one. */
export function createRunPool(file = path.join(__dirname, 'worker.cjs'), timeoutMs: (input: RunInput) => number = hardTimeout): RunPool {
  let worker: Worker | undefined;
  let nextId = 0;
  const jobs = new Map<number, Job>();

  const failAll = (w: Worker, err: Error) => {
    if (worker !== w) return;
    worker = undefined;
    for (const [id, j] of jobs) { clearTimeout(j.timer); j.ko(err); jobs.delete(id); }
  };

  // (re)starts the job's watchdog; on expiry the worker dies and other jobs in it with it
  const arm = (w: Worker, j: Job, limit: number, what: string) => {
    clearTimeout(j.timer);
    j.timer = setTimeout(() => {
      failAll(w, Object.assign(new Error(`${what} did not finish within ${limit} ms; the script runner was restarted`), { statusCode: 504 }));
      void w.terminate();
    }, limit);
  };

  const spawn = () => {
    const w = new Worker(file, { workerData: { role: 'run' } });
    w.on('message', (m: WorkerMessage) => {
      const j = jobs.get(m.jobId);
      if (!j) return;
      if ('event' in m) return j.onEvent?.(m);
      jobs.delete(m.jobId);
      clearTimeout(j.timer);
      if ('error' in m) j.ko(Object.assign(new Error(m.error), { statusCode: m.statusCode }));
      else j.ok(m);
    });
    w.on('error', (e) => failAll(w, e));
    w.on('exit', (code) => failAll(w, new Error(`Run worker exited with code ${code}`)));
    return w;
  };

  const nodeLimit = (input: FlowInput, nodeId: string) => {
    const n = input.flow.nodes.find((x) => x.id === nodeId);
    if (n?.type !== 'request') return HTTP_TIMEOUT_MS + 5000;
    const { collectionId, requestId } = n.data;
    try {
      return timeoutMs({ collection: input.collections[collectionId], requestId, override: input.overrides?.[requestId], scopes: { runtime: {}, environment: [], collection: [], globals: [] } });
    } catch {
      return HTTP_TIMEOUT_MS + 5000; // missing collection/request: the engine turns it into a Fail without I/O
    }
  };

  return {
    run(input) {
      const limit = timeoutMs(input); // also validates that the request exists before touching the worker
      const w = (worker ??= spawn());
      const jobId = nextId++;
      return new Promise((ok, ko) => {
        const job: Job = { ok: (m) => ok(m as RunOutput), ko };
        jobs.set(jobId, job);
        arm(w, job, limit, 'Run');
        w.postMessage({ jobId, input });
      });
    },
    runFlow(input, onEvent) {
      const w = (worker ??= spawn());
      const jobId = nextId++;
      let cancelled = false;
      let job!: Job;
      const done = new Promise<FlowDone>((ok, ko) => {
        job = {
          ok: (m) => { const { jobId: _, ...out } = m as FlowJobDone; ok(out); },
          ko,
          // the watchdog is per node: a whole flow has no known duration
          onEvent: (e) => { if (e.event === 'start' && !cancelled) arm(w, job, nodeLimit(input, e.nodeId), `Node ${e.nodeId}`); onEvent(e); },
        };
        jobs.set(jobId, job);
        w.postMessage({ jobId, flow: input });
      });
      return {
        done,
        cancel() {
          if (cancelled || !jobs.has(jobId)) return;
          cancelled = true;
          w.postMessage({ jobId, cancel: true });
          arm(w, job, SCRIPT_TIMEOUT_MS + 1000, 'Cancelled flow'); // a running script ends by itself within its timeout
        },
      };
    },
    async close() {
      const w = worker;
      if (!w) return;
      failAll(w, new Error('Run pool closed'));
      await w.terminate();
    },
  };
}
