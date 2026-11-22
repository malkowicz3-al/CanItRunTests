import { useState, type ReactNode } from 'react';
import { Button, Divider, Group, PasswordInput, ScrollArea, Select, Stack, Switch, Text, TextInput, Textarea, Title, UnstyledButton } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import type { Environment, Variable } from '../../../shared/model';
import { api } from '../api';
import { notifyError, useApp, useDraft } from '../context';
import { ConfirmModal, Icons } from './ui';
import { VariablesTable } from './VariablesTable';

const mono = { input: { fontFamily: 'var(--mantine-font-family-monospace)' } };

function Shell({ title, subtitle, dirty, onSave, actions, children }: {
  title: ReactNode; subtitle?: ReactNode; dirty: boolean; onSave: () => Promise<void>; actions?: ReactNode; children: ReactNode;
}) {
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try { await onSave(); } catch (e) { notifyError(e); } finally { setSaving(false); }
  };
  useHotkeys([['mod+S', save]], []);
  return (
    <Stack h="100%" gap={0}>
      <Group px="md" py="xs" justify="space-between" wrap="nowrap" className="panel-header">
        <div style={{ minWidth: 0, flex: 1 }}>{title}{subtitle && <Text size="xs" c="dimmed">{subtitle}</Text>}</div>
        <Group gap="xs" wrap="nowrap">
          {dirty && <Text size="xs" c="dimmed"><span className="signal-dot" data-signal="caution" /> Unsaved</Text>}
          {actions}
          <Button onClick={save} disabled={!dirty} loading={saving}>Save</Button>
        </Group>
      </Group>
      <ScrollArea style={{ flex: 1 }}><Stack p="md" gap="md" maw={1100}>{children}</Stack></ScrollArea>
    </Stack>
  );
}

export function EnvironmentEditor({ env }: { env: Environment }) {
  const app = useApp();
  const [draft, update, dirty] = useDraft(env.id, env);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (patch: Partial<Environment>) => update({ ...draft, ...patch });
  const cert = draft.clientCert;
  const setCert = (patch: Partial<NonNullable<Environment['clientCert']>>) => set({ clientCert: { cert: '', key: '', ...cert, ...patch } });

  const remove = async () => {
    try {
      await api.deleteEnvironment(env.id);
      app.setDraft(env.id, undefined);
      if (app.activeEnvId === env.id) app.setActiveEnvId(null);
      app.editEnvironment(null);
      await app.reload();
    } catch (e) { notifyError(e); }
  };

  return (
    <Shell
      dirty={dirty}
      onSave={() => app.saveEnvironment(draft)}
      title={<TextInput variant="unstyled" size="lg" fw={600} value={draft.name} onChange={(e) => set({ name: e.currentTarget.value })} aria-label="Environment name" />}
      subtitle={app.activeEnvId === env.id ? 'Active environment' : 'Environment'}
      actions={<>
        {app.activeEnvId !== env.id && <Button variant="default" onClick={() => app.setActiveEnvId(env.id)}>Set active</Button>}
        <Button variant="subtle" color="stop" leftSection={Icons.trash()} onClick={() => setConfirmDelete(true)}>Delete</Button>
      </>}
    >
      <VariablesTable rows={draft.values} onChange={(values) => set({ values })} secrets keyLabel="Variable" />
      <Divider label="Settings" labelPosition="left" />
      <Switch label="Follow redirects" description="Default for requests in this environment (a request can override it)" checked={draft.followRedirects} onChange={(e) => set({ followRedirects: e.currentTarget.checked })} />
      <Switch label="Ignore TLS certificate errors" description="Accept self-signed and invalid certificates" color="stop" checked={draft.ignoreTls} onChange={(e) => set({ ignoreTls: e.currentTarget.checked })} />
      <Switch
        label="Client certificate (mTLS)"
        description="PEM contents, or {{variables}} holding them"
        checked={cert !== undefined}
        onChange={(e) => set({ clientCert: e.currentTarget.checked ? { cert: '', key: '' } : undefined })}
      />
      {cert && (
        <Stack gap="xs" pl={48}>
          <Textarea label="Certificate" autosize minRows={2} maxRows={8} styles={mono} placeholder="{{clientCertPem}}" value={cert.cert} onChange={(e) => setCert({ cert: e.currentTarget.value })} />
          <Textarea label="Private key" autosize minRows={2} maxRows={8} styles={mono} placeholder="{{clientKeyPem}}" value={cert.key} onChange={(e) => setCert({ key: e.currentTarget.value })} />
          <PasswordInput label="Passphrase" styles={mono} value={cert.passphrase ?? ''} onChange={(e) => setCert({ passphrase: e.currentTarget.value || undefined })} />
          <Textarea label="CA certificate" autosize minRows={1} maxRows={8} styles={mono} placeholder="optional" value={cert.ca ?? ''} onChange={(e) => setCert({ ca: e.currentTarget.value || undefined })} />
        </Stack>
      )}
      <ConfirmModal opened={confirmDelete} onClose={() => setConfirmDelete(false)} onConfirm={remove} title="Delete environment" message={<>Delete <b>{env.name}</b>? This cannot be undone.</>} />
    </Shell>
  );
}

/** Collection variables and globals: just a variables table. */
export function VariablesEditor({ draftKey, title, subtitle, values, onSave }: {
  draftKey: string; title: string; subtitle: string; values: Variable[]; onSave: (values: Variable[]) => Promise<void>;
}) {
  const [draft, update, dirty] = useDraft(draftKey, values);
  return (
    <Shell dirty={dirty} onSave={() => onSave(draft)} title={<Title order={3} fz="lg">{title}</Title>} subtitle={subtitle}>
      <VariablesTable rows={draft} onChange={update} secrets keyLabel="Variable" />
    </Shell>
  );
}

/** Environments screen: globals and environments as rows on the left, the editor on the right. */
export function EnvironmentsView() {
  const app = useApp();
  const sel = app.envSelection;
  const env = app.environments.find((e) => e.id === sel);
  const create = async () => {
    try {
      const e = await api.createEnvironment({ name: 'New environment' });
      await app.reload();
      app.editEnvironment(e.id);
    } catch (e) { notifyError(e); }
  };
  const count = (n: number) => `${n} variable${n === 1 ? '' : 's'}`;
  const row = (id: string, name: string, meta: string) => (
    <UnstyledButton key={id} className="env-row" data-active={sel === id || undefined} onClick={() => app.editEnvironment(id)}>
      <Text truncate fw={500}>{name}</Text>
      <Text size="xs" c="dimmed">{id in app.drafts ? 'Unsaved' : meta}</Text>
    </UnstyledButton>
  );
  return (
    <div className="env-screen">
      <div className="env-list">
        <Group p="sm"><Button variant="default" fullWidth leftSection={Icons.plus()} onClick={create}>New environment</Button></Group>
        <ScrollArea style={{ flex: 1 }} type="hover">
          {row('globals', 'Globals', count(app.globals.values.length))}
          {app.environments.map((e) => row(e.id, e.name, app.activeEnvId === e.id ? `Active · ${count(e.values.length)}` : count(e.values.length)))}
          {!app.environments.length && <Text size="xs" c="dimmed" p="md">No environments. Import a Postman environment or create one.</Text>}
        </ScrollArea>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {env ? <EnvironmentEditor key={env.id} env={env} />
          : sel === 'globals' ? <VariablesEditor key="globals" draftKey="globals" title="Globals" subtitle="Variables available in every collection and environment" values={app.globals.values} onSave={(values) => app.saveGlobals({ values })} />
          : <Text c="dimmed" p="xl">Select an environment or globals to edit variables.</Text>}
      </div>
    </div>
  );
}

/** Active environment picker in the top bars of Requests and Flows. */
export function EnvironmentSelect() {
  const app = useApp();
  return (
    <Select
      w={220} placeholder="No environment" clearable searchable aria-label="Active environment" leftSection={Icons.layers()}
      data={app.environments.map((e) => ({ value: e.id, label: e.name }))}
      value={app.environments.some((e) => e.id === app.activeEnvId) ? app.activeEnvId : null}
      onChange={app.setActiveEnvId}
    />
  );
}
