// Worker entry. Role 'run': single shots (stage 1) and flows (stage 2); role 'load' comes in stage 3.
import { parentPort, workerData } from 'node:worker_threads';
import type { FlowStatus, RunResult, Scopes } from '../shared/api';
import type { Id, Pin } from '../shared/model';
import { runFlow, type FlowInput } from './core/flow';
import { diffScopes, runRequest, type RunInput, type ScopeDiff } from './core/run';

export interface RunJob { jobId: number; input: RunInput }
export interface FlowJob { jobId: number; flow: FlowInput }
export interface CancelJob { jobId: number; cancel: true }
export type RunJobResult =
  | { jobId: number; result: Awaited<ReturnType<typeof runRequest>>; diff: ReturnType<typeof diffScopes> }
  | { jobId: number; error: string; statusCode?: number };
export type FlowJobEvent =
  | { jobId: number; event: 'start'; nodeId: Id }
  | { jobId: number; event: 'end'; nodeId: Id; outcome: Pin; result: RunResult; diff: ScopeDiff; collectionId: Id };
export interface FlowJobDone { jobId: number; status: FlowStatus; nodeRuns: number }
export type WorkerMessage = RunJobResult | FlowJobEvent | FlowJobDone;

if (parentPort && workerData?.role === 'run') {
  const port = parentPort;
  const flows = new Map<number, AbortController>();
  // safety net: a stray rejection from a user script must not kill the worker and every job in it
  process.on('unhandledRejection', (e) => console.error(e));
  port.on('message', async (m: RunJob | FlowJob | CancelJob) => {
    const { jobId } = m;
    if ('cancel' in m) return flows.get(jobId)?.abort();
    try {
      if ('flow' in m) {
        const ac = new AbortController();
        flows.set(jobId, ac);
        let before: Scopes | undefined;
        const out = await runFlow(m.flow, {
          signal: ac.signal,
          onNodeStart: (node, scopes) => {
            before = structuredClone(scopes);
            port.postMessage({ jobId, event: 'start', nodeId: node.id } satisfies FlowJobEvent);
          },
          onNodeEnd: (node, result, outcome, scopes) => {
            const collectionId = node.type === 'request' ? node.data.collectionId : '';
            port.postMessage({ jobId, event: 'end', nodeId: node.id, outcome, result, diff: diffScopes(before!, scopes), collectionId } satisfies FlowJobEvent);
          },
        });
        port.postMessage({ jobId, ...out } satisfies FlowJobDone);
        return;
      }
      const before = structuredClone(m.input.scopes);
      const result = await runRequest(m.input);
      port.postMessage({ jobId, result, diff: diffScopes(before, result.scopes) } satisfies RunJobResult);
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      port.postMessage({ jobId, error: err.message, statusCode: err.statusCode } satisfies RunJobResult);
    } finally {
      flows.delete(jobId);
    }
  });
}
