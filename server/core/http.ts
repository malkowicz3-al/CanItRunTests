import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import zlib from 'node:zlib';
import type { HttpError, HttpResponse, PreparedRequest, Redirect } from '../../shared/api';
import type { Environment } from '../../shared/model';

export interface HttpOptions {
  ignoreTls: boolean;
  clientCert?: Environment['clientCert']; // already resolved PEMs
  timeoutMs: number;
  agents?: { http: http.Agent; https: https.Agent }; // keep-alive agents for load; single shots open a fresh socket
  followRedirects?: boolean; // default true
  signal?: AbortSignal; // cancel: aborts the hop in flight and stops the redirect chain
}

export interface HttpResult {
  finalRequest: PreparedRequest; // last request actually sent
  redirects: Redirect[];
  response?: HttpResponse;
  error?: HttpError;
}

const RESPONSE_BODY_LIMIT = 10 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function execute(req: PreparedRequest, opts: HttpOptions): Promise<HttpResult> {
  const redirects: Redirect[] = [];
  let current = req;
  const deadline = performance.now() + opts.timeoutMs; // one budget for the request and all its redirect hops
  try {
    for (;;) {
      const response = await once(current, opts, deadline);
      const location = response.headers.location;
      if (opts.followRedirects === false || !REDIRECT_STATUSES.has(response.status) || typeof location !== 'string') {
        return { finalRequest: current, redirects, response };
      }
      redirects.push({ status: response.status, method: current.method, url: current.url });
      if (redirects.length > MAX_REDIRECTS) {
        return { finalRequest: current, redirects, error: { code: 'ERR_TOO_MANY_REDIRECTS', message: `Exceeded ${MAX_REDIRECTS} redirects` } };
      }
      current = nextRequest(current, response.status, location);
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { finalRequest: current, redirects, error: { code: opts.signal?.aborted ? 'ECANCELED' : err.code ?? 'ERROR', message: opts.signal?.aborted ? 'Cancelled' : err.message } };
  }
}

function nextRequest(prev: PreparedRequest, status: number, location: string): PreparedRequest {
  const url = new URL(location, prev.url);
  const toGet = (status === 303 && prev.method !== 'HEAD') || ((status === 301 || status === 302) && prev.method === 'POST');
  const crossHost = url.host !== new URL(prev.url).host;
  const drop = new Set([...(toGet ? ['content-type', 'content-length'] : []), ...(crossHost ? ['authorization', 'cookie'] : [])]);
  const headers = Object.fromEntries(Object.entries(prev.headers).filter(([k]) => !drop.has(k.toLowerCase())));
  return { method: toGet ? 'GET' : prev.method, url: url.href, headers, body: toGet ? undefined : prev.body };
}

function once(req: PreparedRequest, opts: HttpOptions, deadline: number): Promise<HttpResponse> {
  const url = new URL(req.url);
  const isHttps = url.protocol === 'https:';
  if (!isHttps && url.protocol !== 'http:') throw Object.assign(new Error(`Unsupported protocol ${url.protocol}`), { code: 'ERR_INVALID_PROTOCOL' });
  const c = opts.clientCert;
  const options: https.RequestOptions = {
    method: req.method,
    headers: req.headers,
    agent: (isHttps ? opts.agents?.https : opts.agents?.http) ?? false,
    signal: opts.signal,
    ...(isHttps && { rejectUnauthorized: !opts.ignoreTls, cert: c?.cert || undefined, key: c?.key || undefined, passphrase: c?.passphrase || undefined, ca: c?.ca || undefined }),
  };

  return new Promise((resolve, reject) => {
    const start = performance.now();
    let lookup: number | undefined, connect: number | undefined, secure: number | undefined;
    const r = (isHttps ? https : http).request(url, options);
    const timer = setTimeout(() => r.destroy(Object.assign(new Error(`Timeout after ${opts.timeoutMs} ms`), { code: 'ETIMEDOUT' })), Math.max(0, deadline - performance.now()));
    const fail = (e: Error) => { clearTimeout(timer); r.destroy(); reject(e); };
    r.on('error', fail);
    r.on('socket', (s) => {
      if (r.reusedSocket) return; // keep-alive: no dns/tcp/tls, and once() listeners would pile up on the socket
      s.once('lookup', () => { lookup = performance.now(); });
      s.once('connect', () => { connect = performance.now(); });
      s.once('secureConnect', () => { secure = performance.now(); });
    });
    r.on('response', (res) => {
      const ttfbAt = performance.now();
      const bodiless = req.method.toUpperCase() === 'HEAD' || res.statusCode === 204 || res.statusCode === 304 || res.headers['content-length'] === '0';
      const enc = bodiless ? undefined : res.headers['content-encoding'];
      // sync flush: a truncated compressed body yields what was decoded instead of an error
      const decoder = enc === 'br' ? zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH })
        : enc === 'gzip' || enc === 'deflate' ? zlib.createUnzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH }) : undefined;
      const stream = decoder ? res.pipe(decoder) : res;
      const chunks: Buffer[] = [];
      let size = 0, kept = 0, truncated = false;
      res.on('data', (b: Buffer) => { size += b.length; });
      res.on('error', fail);
      decoder?.on('error', fail);
      stream.on('data', (b: Buffer) => {
        if (kept >= RESPONSE_BODY_LIMIT) { truncated = true; return; }
        if (kept + b.length > RESPONSE_BODY_LIMIT) { truncated = true; b = b.subarray(0, RESPONSE_BODY_LIMIT - kept); }
        chunks.push(b);
        kept += b.length;
      });
      stream.on('end', () => {
        clearTimeout(timer);
        const end = performance.now();
        const before = secure ?? connect ?? lookup ?? start;
        resolve({
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? '',
          headers: res.headers as Record<string, string | string[]>,
          body: Buffer.concat(chunks).toString('utf8'),
          size,
          truncated,
          timings: {
            dns: lookup === undefined ? 0 : lookup - start,
            tcp: connect === undefined ? 0 : connect - (lookup ?? start),
            tls: secure === undefined || connect === undefined ? 0 : secure - connect,
            ttfb: ttfbAt - before,
            transfer: end - ttfbAt,
            total: end - start,
          },
        });
      });
    });
    r.end(req.body);
  });
}
