export type Id = string; // crypto.randomUUID()

export interface Variable { key: string; value: string; type?: 'default' | 'secret'; enabled: boolean }
export interface KeyValue { key: string; value: string; enabled: boolean }

export type Auth =
  | { type: 'inherit' } // no auth in Postman = inherit
  | { type: 'none' } // Postman 'noauth'
  | { type: 'bearer'; token: string } // also OAuth2 with a ready token
  | { type: 'basic'; username: string; password: string }
  | { type: 'apikey'; key: string; value: string; in: 'header' | 'query' };

export interface Scripts { pre: string; test: string } // empty string = none

export type Body =
  | { mode: 'none' }
  | { mode: 'raw'; raw: string; language: 'json' | 'xml' | 'text' }
  | { mode: 'urlencoded'; params: KeyValue[] }
  | { mode: 'formdata'; params: KeyValue[] }; // shortcut: text fields only, files when someone asks

export interface RequestItem {
  kind: 'request'; id: Id; name: string;
  method: string;
  url: string; // raw, with {{variables}}
  pathVariables: KeyValue[]; // Postman ':id'
  headers: KeyValue[]; body: Body; auth: Auth; scripts: Scripts;
  followRedirects?: boolean; // undefined = take from environment
}
export interface Folder { kind: 'folder'; id: Id; name: string; items: Item[]; auth: Auth; scripts: Scripts }
export type Item = Folder | RequestItem;

export interface Collection {
  id: Id; sourceId?: string; // info._postman_id, detects re-import
  name: string; items: Item[]; auth: Auth; scripts: Scripts; variables: Variable[];
}

export interface Environment {
  id: Id; sourceId?: string; name: string; values: Variable[];
  ignoreTls: boolean;
  followRedirects: boolean; // default true
  clientCert?: { cert: string; key: string; passphrase?: string; ca?: string }; // templates, e.g. '{{clientCertPem}}'
}

export interface Globals { values: Variable[] }

export interface XY { x: number; y: number }
export type FlowNode =
  | { id: Id; type: 'start'; position: XY; data: Record<string, never> }
  | { id: Id; type: 'request'; position: XY; data: { collectionId: Id; requestId: Id; continueWhen: number[] } }; // [] = any 2xx
export type Pin = 'ok' | 'fail'; // Start has only 'ok'
export interface FlowEdge { id: Id; source: Id; sourceHandle: Pin; target: Id }
export interface Flow { id: Id; name: string; nodes: FlowNode[]; edges: FlowEdge[]; maxNodeRuns?: number } // absent = FLOW_MAX_NODE_RUNS
