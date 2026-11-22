import path from 'node:path';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { BODY_LIMIT, HOST, PORT } from './config';
import { registerFlows } from './flows';
import { registerRoutes } from './routes';
import { createRunPool } from './runPool';
import { registerWs } from './ws';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`Node 22 or newer is required, found ${process.versions.node}.`);
  process.exit(1);
}

const app = Fastify({ bodyLimit: BODY_LIMIT, logger: { level: 'warn' } });

const pool = createRunPool();
registerWs(app); // the Host guard from registerRoutes covers the /ws upgrade too (flows.test.ts)
registerRoutes(app, pool);
registerFlows(app, pool);

const publicDir = path.join(__dirname, 'public');
app.register(fastifyStatic, { root: publicDir });
app.setNotFoundHandler((req, reply) => {
  if (req.method !== 'GET' || req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
  return reply.sendFile('index.html');
});

app.listen({ port: PORT, host: HOST }).then(
  () => {
    const port = (app.server.address() as AddressInfo).port;
    const shownHost = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
    console.log(`CanItRunTests listening on http://${shownHost}:${port}`);
    if (HOST !== 'localhost' && HOST !== '127.0.0.1') {
      console.warn(`WARNING: bound to ${HOST} without authentication; anyone on the network can read environments and send requests.`);
    }
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
