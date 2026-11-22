import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import jsrsasign from 'jsrsasign';

function keyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

let serial = 1;
function cert(subject: string, publicKey: string, issuer: string, caKey: string, ext: object[]): string {
  return new jsrsasign.KJUR.asn1.x509.Certificate({
    version: 3,
    serial: { int: serial++ },
    issuer: { str: issuer },
    subject: { str: subject },
    notbefore: '200101000000Z',
    notafter: '491231235959Z',
    sbjpubkey: publicKey,
    ext,
    sigalg: 'SHA256withRSA',
    cakey: caKey,
  } as never).getPEM();
}

/** Test CA, server cert (localhost/127.0.0.1) and client cert for mTLS, all generated per run. */
export function makeCerts() {
  const ca = keyPair();
  const caCert = cert('/CN=Test CA', ca.publicKey, '/CN=Test CA', ca.privateKey, [{ extname: 'basicConstraints', cA: true, critical: true }]);
  const srv = keyPair();
  const serverCert = cert('/CN=localhost', srv.publicKey, '/CN=Test CA', ca.privateKey, [
    { extname: 'subjectAltName', array: [{ dns: 'localhost' }, { ip: '127.0.0.1' }] },
  ]);
  const cli = keyPair();
  const clientCert = cert('/CN=client', cli.publicKey, '/CN=Test CA', ca.privateKey, []);
  return { ca: caCert, server: { cert: serverCert, key: srv.privateKey }, client: { cert: clientCert, key: cli.privateKey } };
}

// Routes: /echo, /gzip, /br, /deflate, /slow?ms=, /big, /redirect?status=&to=, /loop, /status?code=, /seq?key=&codes=500,200 (next code per key, last repeats)
const seqHits = new Map<string, number>();
function handler(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const q = url.searchParams;
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const echo = JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    switch (url.pathname) {
      case '/gzip': res.writeHead(200, { 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(echo));
      case '/br': res.writeHead(200, { 'content-encoding': 'br' }); return res.end(zlib.brotliCompressSync(echo));
      case '/deflate': res.writeHead(200, { 'content-encoding': 'deflate' }); return res.end(zlib.deflateSync(echo));
      case '/slow': return setTimeout(() => res.end(echo), Number(q.get('ms') ?? 1000));
      case '/big': return res.end(Buffer.alloc(11 * 1024 * 1024, 'a'));
      case '/redirect':
        res.writeHead(Number(q.get('status') ?? 302), { location: q.get('to') ?? '/echo' });
        return res.end();
      case '/status': res.writeHead(Number(q.get('code') ?? 200)); return res.end(echo);
      case '/seq': {
        const codes = (q.get('codes') ?? '200').split(',').map(Number);
        const n = seqHits.get(q.get('key') ?? '') ?? 0;
        seqHits.set(q.get('key') ?? '', n + 1);
        res.writeHead(codes[Math.min(n, codes.length - 1)]);
        return res.end(echo);
      }
      case '/loop': res.writeHead(302, { location: '/loop' }); return res.end();
      default: res.writeHead(200, { 'content-type': 'application/json' }); return res.end(echo);
    }
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

export async function startMockServer() {
  const certs = makeCerts();
  const plain = http.createServer(handler);
  const tls = https.createServer({ ...certs.server }, handler);
  const mtls = https.createServer({ ...certs.server, ca: certs.ca, requestCert: true, rejectUnauthorized: true }, handler);
  const [p1, p2, p3] = await Promise.all([listen(plain), listen(tls), listen(mtls)]);
  return {
    certs,
    http: `http://127.0.0.1:${p1}`,
    httpPort: p1,
    https: `https://127.0.0.1:${p2}`,
    mtls: `https://127.0.0.1:${p3}`,
    close: () => Promise.all([plain, tls, mtls].map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); }))),
  };
}
