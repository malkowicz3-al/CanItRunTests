import { useRef, useState } from 'react';
import { Box, PasswordInput, SegmentedControl, Select, Stack, Text, TextInput, Tooltip, Group } from '@mantine/core';
import type { Auth, Body, Collection, RequestItem } from '../../../shared/model';
import { notifyError, useApp, useDraft } from '../context';
import { resolveVar } from '../track';
import { parseQuery, syncPathVars, updateTree, withQuery } from '../util';
import { CodeEditor } from './CodeEditor';
import { MethodGlyph } from './ui';
import { VariablesTable } from './VariablesTable';

// Field editors of a request, shared by the Flows inspector (sections) and the Requests workbench (tabs).

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const mono = { input: { fontFamily: 'var(--mantine-font-family-monospace)' } };

type Edit = { draft: RequestItem; set: (patch: Partial<RequestItem>) => void };
/** `scope` keeps Monaco model paths apart: Requests and the Flows inspector can show the same request at once. */
type FieldsProps = Edit & { scope: 'requests' | 'flows' };

/** Draft of a saved request plus its save action; `active` = the screen is visible (hotkeys of hidden screens do nothing). */
export function useRequestDraft(collection: Collection, saved: RequestItem, active: boolean) {
  const app = useApp();
  const [draft, update, dirty] = useDraft(saved.id, saved);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<RequestItem>) => update({ ...draft, ...patch });
  const save = async () => {
    if (!active || !dirty || saving) return;
    setSaving(true);
    try {
      await app.saveCollection(collection.id, (latest) => ({ ...latest, items: updateTree(latest.items, saved.id, () => draft) }));
      app.discardDraft(saved.id, draft);
    } catch (e) { notifyError(e); } finally { setSaving(false); }
  };
  return { draft, set, dirty, saving, save };
}

function AuthEditor({ auth, onChange }: { auth: Auth; onChange: (a: Auth) => void }) {
  const field = (label: string, value: string, set: (v: string) => void, secret?: boolean) => {
    const Input = secret ? PasswordInput : TextInput;
    return <Input label={label} styles={mono} value={value} onChange={(e) => set(e.currentTarget.value)} />;
  };
  const defaults: Record<Auth['type'], Auth> = {
    inherit: { type: 'inherit' }, none: { type: 'none' }, bearer: { type: 'bearer', token: '' },
    basic: { type: 'basic', username: '', password: '' }, apikey: { type: 'apikey', key: '', value: '', in: 'header' },
  };
  return (
    <Stack gap="sm">
      <Select
        label="Type" allowDeselect={false} value={auth.type} onChange={(t) => t && onChange(defaults[t as Auth['type']])}
        data={[{ value: 'inherit', label: 'Inherit from parent' }, { value: 'none', label: 'No auth' }, { value: 'bearer', label: 'Bearer token' }, { value: 'basic', label: 'Basic auth' }, { value: 'apikey', label: 'API key' }]}
      />
      {auth.type === 'inherit' && <Text c="dimmed">Uses the auth of the parent folder or collection.</Text>}
      {auth.type === 'bearer' && field('Token', auth.token, (token) => onChange({ ...auth, token }))}
      {auth.type === 'basic' && <>
        {field('Username', auth.username, (username) => onChange({ ...auth, username }))}
        {field('Password', auth.password, (password) => onChange({ ...auth, password }), true)}
      </>}
      {auth.type === 'apikey' && <>
        {field('Key', auth.key, (key) => onChange({ ...auth, key }))}
        {field('Value', auth.value, (value) => onChange({ ...auth, value }))}
        <SegmentedControl value={auth.in} onChange={(v) => onChange({ ...auth, in: v as 'header' | 'query' })} data={[{ value: 'header', label: 'Header' }, { value: 'query', label: 'Query params' }]} />
      </>}
    </Stack>
  );
}

function BodyEditor({ path, body, onChange }: { path: string; body: Body; onChange: (b: Body) => void }) {
  const stash = useRef<Partial<Record<Body['mode'], Body>>>({}); // switching modes back and forth keeps what was typed
  const setMode = (mode: Body['mode']) => {
    stash.current[body.mode] = body;
    onChange(stash.current[mode] ?? (mode === 'raw' ? { mode, raw: '', language: 'json' } : mode === 'none' ? { mode } : { mode, params: [] }));
  };
  return (
    <Stack gap="xs">
      <SegmentedControl value={body.mode} onChange={(m) => setMode(m as Body['mode'])} data={[{ value: 'none', label: 'None' }, { value: 'raw', label: 'Raw' }, { value: 'urlencoded', label: 'URL-encoded' }, { value: 'formdata', label: 'Form data' }]} />
      {body.mode === 'raw' && (
        <SegmentedControl value={body.language} onChange={(l) => onChange({ ...body, language: l as 'json' | 'xml' | 'text' })} data={[{ value: 'json', label: 'JSON' }, { value: 'xml', label: 'XML' }, { value: 'text', label: 'Text' }]} />
      )}
      {body.mode === 'none' && <Text c="dimmed">This request has no body.</Text>}
      {body.mode === 'raw' && (
        <Box className="editor-box" h={260}>
          <CodeEditor path={path} language={body.language === 'text' ? 'plaintext' : body.language} value={body.raw} onChange={(raw) => onChange({ ...body, raw })} />
        </Box>
      )}
      {(body.mode === 'urlencoded' || body.mode === 'formdata') && <VariablesTable rows={body.params} onChange={(params) => onChange({ ...body, params })} />}
    </Stack>
  );
}

/** The URL with its {{variables}} marked; hovering one shows the value from the active scopes. */
function UrlVariables({ url, collection }: { url: string; collection: Collection }) {
  const app = useApp();
  if (!url.includes('{{')) return null;
  const env = app.environments.find((e) => e.id === app.activeEnvId);
  return (
    <div className="url-vars">
      {url.split(/(\{\{[^{}]+\}\})/).map((part, i) => {
        const key = /^\{\{([^{}]+)\}\}$/.exec(part)?.[1];
        if (!key) return <span key={i}>{part}</span>;
        const v = resolveVar(key, env, collection, app.globals);
        const label = v
          ? (v.type === 'secret' ? 'Secret value (hidden)' : v.value || '(empty)')
          : `Variable {{${key}}} is not defined in ${env ? env.name : 'any environment'}, the collection or globals. A script may still set it.`;
        return (
          <Tooltip key={i} label={label} multiline maw={380} openDelay={150}>
            <span className={v ? 'var-ok' : 'var-missing'} tabIndex={0}>{part}</span>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** Method select + URL (mono) with the resolved {{variables}} below; `action` sits right of the URL (Send button). */
export function RequestLine({ draft, set, collection, action }: Edit & { collection: Collection; action?: React.ReactNode }) {
  return (
    <Stack gap={6}>
      <Group gap={6} wrap="nowrap">
        <Select
          w={104} allowDeselect={false} value={draft.method} data={METHODS.includes(draft.method) ? METHODS : [draft.method, ...METHODS]}
          onChange={(m) => m && set({ method: m })} aria-label="Method" renderOption={({ option }) => <MethodGlyph method={option.value} />}
        />
        <TextInput
          style={{ flex: 1 }} placeholder="https://{{host}}/path" value={draft.url} aria-label="URL" styles={mono}
          onChange={(e) => { const url = e.currentTarget.value; set({ url, pathVariables: syncPathVars(url, draft.pathVariables) }); }}
        />
        {action}
      </Group>
      <UrlVariables url={draft.url} collection={collection} />
    </Stack>
  );
}

function QueryPathFields({ draft, set }: FieldsProps) {
  return (
    <Stack gap="sm">
      <VariablesTable rows={parseQuery(draft.url)} toggle={false} onChange={(q) => set({ url: withQuery(draft.url, q) })} />
      {draft.pathVariables.length > 0 && <>
        <Text size="xs" c="dimmed">Path variables</Text>
        <VariablesTable rows={draft.pathVariables} fixedKeys onChange={(pathVariables) => set({ pathVariables })} />
      </>}
    </Stack>
  );
}

const HeadersFields = ({ draft, set }: FieldsProps) => <VariablesTable rows={draft.headers} onChange={(headers) => set({ headers })} />;
const BodyFields = ({ draft, set, scope }: FieldsProps) => <BodyEditor key={draft.id} path={`${scope}/${draft.id}/body`} body={draft.body} onChange={(body) => set({ body })} />;
const AuthFields = ({ draft, set }: FieldsProps) => <AuthEditor auth={draft.auth} onChange={(auth) => set({ auth })} />;

function ScriptsFields({ draft, set, scope }: FieldsProps) {
  return (
    <Stack gap="xs">
      <Text size="xs" c="dimmed">Pre-request</Text>
      <Box className="editor-box" h={200}><CodeEditor path={`${scope}/${draft.id}/pre.js`} language="javascript" value={draft.scripts.pre} onChange={(pre) => set({ scripts: { ...draft.scripts, pre } })} /></Box>
      <Text size="xs" c="dimmed">Tests</Text>
      <Box className="editor-box" h={200}><CodeEditor path={`${scope}/${draft.id}/test.js`} language="javascript" value={draft.scripts.test} onChange={(test) => set({ scripts: { ...draft.scripts, test } })} /></Box>
    </Stack>
  );
}

function SettingsFields({ draft, set }: FieldsProps) {
  return (
    <Stack gap={6}>
      <Text fw={500}>Follow redirects</Text>
      <SegmentedControl
        value={draft.followRedirects === undefined ? 'inherit' : draft.followRedirects ? 'on' : 'off'}
        onChange={(v) => set({ followRedirects: v === 'inherit' ? undefined : v === 'on' })}
        data={[{ value: 'inherit', label: 'From environment' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]}
      />
      <Text size="xs" c="dimmed">Up to 10 redirects. Authorization and Cookie headers are dropped when the host changes.</Text>
    </Stack>
  );
}

/** The editable parts in display order, with the counter shown next to each title (0 = no counter). */
export const REQUEST_PARTS = [
  { id: 'params', title: 'Params', sectionTitle: 'Query & path', Fields: QueryPathFields },
  { id: 'headers', title: 'Headers', sectionTitle: 'Headers', Fields: HeadersFields },
  { id: 'body', title: 'Body', sectionTitle: 'Body', Fields: BodyFields },
  { id: 'auth', title: 'Auth', sectionTitle: 'Auth', Fields: AuthFields },
  { id: 'scripts', title: 'Scripts', sectionTitle: 'Scripts', Fields: ScriptsFields },
  { id: 'settings', title: 'Settings', sectionTitle: 'Settings', Fields: SettingsFields },
] as const;
