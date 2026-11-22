import websocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import type { WsMessage } from '../shared/api';

const clients = new Set<WebSocket>();

function originHost(origin: string): string | undefined {
  try { return new URL(origin).host; } catch { return undefined; }
}

export function registerWs(app: FastifyInstance): void {
  app.register(websocket);
  app.register(async (app) => {
    app.get('/ws', { websocket: true }, (socket: WebSocket, req) => {
      // browsers do not apply same-origin to WebSockets: a foreign page could read run results with secrets
      const origin = req.headers.origin;
      const host = origin === undefined ? undefined : originHost(origin);
      if (origin !== undefined && (host === undefined || host !== req.headers.host?.toLowerCase())) return socket.close(1008, 'Forbidden origin');
      clients.add(socket);
      socket.addEventListener('close', () => clients.delete(socket));
    });
  });
}

export function broadcast(msg: WsMessage): void {
  const text = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(text);
}
