import { randomUUID } from 'node:crypto';
import type { Scopes } from '../../shared/api';

const MAX_DEPTH = 10;
const VAR = /\{\{([^{}]+)\}\}/g;

const dynamic: Record<string, () => string> = {
  $guid: randomUUID,
  $randomUUID: randomUUID,
  $timestamp: () => String(Math.floor(Date.now() / 1000)),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1001)), // 0-1000 inclusive, like Postman
};

export function getVar(s: Scopes, key: string): string | undefined {
  if (Object.hasOwn(s.runtime, key)) return s.runtime[key];
  for (const scope of [s.environment, s.collection, s.globals]) {
    const v = scope.find((x) => x.enabled && x.key === key);
    if (v) return v.value;
  }
  return undefined;
}

export function resolve(template: string, s: Scopes, depth = 1): string {
  return template.replace(VAR, (match, name: string) => {
    const value = Object.hasOwn(dynamic, name) ? dynamic[name]() : getVar(s, name);
    if (value === undefined) return match;
    return depth < MAX_DEPTH ? resolve(value, s, depth + 1) : value;
  });
}
