import type { WsMessage } from '../../shared/api';

/** Server events plus 'open' after each (re)connect: events sent while disconnected are lost, so re-fetch state then. */
export type WsEvent = WsMessage | { type: 'open' };

const listeners = new Set<(e: WsEvent) => void>();
let socket: WebSocket | undefined;
let delay = 1000;

function open() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => { delay = 1000; listeners.forEach((fn) => fn({ type: 'open' })); };
  ws.onmessage = (m) => {
    let e: WsEvent;
    try { e = JSON.parse(String(m.data)) as WsEvent; } catch { return; }
    listeners.forEach((fn) => fn(e));
  };
  ws.onclose = () => { setTimeout(open, delay); delay = Math.min(delay * 2, 5000); };
}

/** One shared socket, opened on the first subscribe and reconnected every 1 to 5 s; returns the unsubscribe. */
export function subscribe(fn: (e: WsEvent) => void): () => void {
  listeners.add(fn);
  if (!socket) open();
  return () => { listeners.delete(fn); };
}
