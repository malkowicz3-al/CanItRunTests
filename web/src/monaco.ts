// Local Monaco: bundled by Vite with its workers, never loaded from a CDN.
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/editor.all.js';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution';
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker: (_id, label) => (label === 'json' ? new JsonWorker() : label === 'typescript' || label === 'javascript' ? new TsWorker() : new EditorWorker()),
};

// Mirrors server/core/sandbox.ts; only for completion and hover, the sandbox decides what really exists.
const PM_DTS = `
interface PmScope { get(key: string): string | undefined; has(key: string): boolean; set(key: string, value: unknown): void; unset(key: string): void }
interface PmHeaders { get(key: string): string | undefined; add(h: { key: string; value: unknown }): void; upsert(h: { key: string; value: unknown }): void; remove(key: string): void; toObject(): Record<string, string> }
interface PmRequest { method: string; url: { toString(): string } | string; headers: PmHeaders; body: { raw: string; toString(): string } }
interface PmResponse {
  code: number; status: string; responseTime: number;
  headers: { get(key: string): string | undefined; has(key: string): boolean; toObject(): Record<string, string | string[]> };
  text(): string; json(): any;
  to: { have: { status(code: number): void } };
}
interface PmSendRequest { url: string; method?: string; header?: Record<string, string> | { key: string; value: string }[]; body?: { mode?: 'raw' | 'urlencoded'; raw?: string; urlencoded?: { key: string; value: string }[] } }
declare const pm: {
  environment: PmScope; collectionVariables: PmScope; globals: PmScope;
  variables: PmScope & { replaceIn(template: string): string };
  request: PmRequest;
  /** Only in test scripts. */
  response: PmResponse;
  info: { requestName: string };
  expect: Chai.ExpectStatic;
  test(name: string, fn: () => void | Promise<void>): void;
  setNextRequest(name: string | null): void;
  sendRequest(req: string | PmSendRequest, cb?: (err: any, res?: PmResponse) => void): Promise<PmResponse | undefined>;
};
declare namespace Chai { interface ExpectStatic { (value: any, message?: string): any; fail(message?: string): never } }
declare const CryptoJS: any;
declare const console: { log(...a: any[]): void; info(...a: any[]): void; warn(...a: any[]): void; error(...a: any[]): void; debug(...a: any[]): void };
declare function setTimeout(fn: (...a: any[]) => void, ms?: number, ...a: any[]): number;
declare function clearTimeout(t: number): void;
/** Allowed: 'crypto', 'jose', 'jsrsasign', 'crypto-js'. */
declare function require(name: 'crypto' | 'jose' | 'jsrsasign' | 'crypto-js'): any;
`;

const js = monaco.languages.typescript.javascriptDefaults;
js.setCompilerOptions({ target: monaco.languages.typescript.ScriptTarget.ESNext, allowNonTsExtensions: true, lib: ['esnext'] });
// scripts run inside an async function: top-level await and return are fine
js.setDiagnosticsOptions({ diagnosticCodesToIgnore: [1108, 1375, 1378] });
js.addExtraLib(PM_DTS, 'ts:pm.d.ts');

// editor background matches the ink token (docs/design/ui-pipeline.md)
monaco.editor.defineTheme('cirt-dark', { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#0E1923', 'editor.lineHighlightBackground': '#15232F' } });
monaco.editor.defineTheme('cirt-light', { base: 'vs', inherit: true, rules: [], colors: { 'editor.background': '#ffffff' } });

loader.config({ monaco });
