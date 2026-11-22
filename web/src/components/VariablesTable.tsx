import { ActionIcon, Checkbox, PasswordInput, Table, TextInput, Tooltip } from '@mantine/core';
import type { Variable } from '../../../shared/model';
import { Icons } from './ui';

const cell = { input: { fontFamily: 'var(--mantine-font-family-monospace)' } };

/** Key/value grid with a trailing blank row for adding; also used for headers and params (Variable is a superset of KeyValue). */
export function VariablesTable<T extends Variable>({ rows, onChange, secrets, toggle = true, fixedKeys, keyLabel = 'Key' }: {
  rows: T[]; onChange: (rows: T[]) => void;
  secrets?: boolean; // secret type with masking
  toggle?: boolean; // enabled checkbox
  fixedKeys?: boolean; // keys come from elsewhere (path variables): no add/remove/rename
  keyLabel?: string;
}) {
  const all = fixedKeys ? rows : [...rows, { key: '', value: '', enabled: true } as T];
  const set = (i: number, patch: Partial<Variable>) => {
    const next = all.map((r, j) => (j === i ? { ...r, ...patch } : r));
    onChange(fixedKeys ? next : next.filter((r, j) => j < rows.length || r.key || r.value));
  };
  return (
    <Table withTableBorder withColumnBorders verticalSpacing={0} horizontalSpacing={0} className="kv-table">
      <Table.Thead>
        <Table.Tr>
          {toggle && <Table.Th w={34} />}
          <Table.Th w="35%">{keyLabel}</Table.Th>
          <Table.Th>Value</Table.Th>
          {(secrets || !fixedKeys) && <Table.Th w={secrets ? 64 : 34} />}
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {all.map((r, i) => {
          const blank = !fixedKeys && i === rows.length;
          const secret = r.type === 'secret';
          return (
            <Table.Tr key={i} style={{ opacity: !blank && toggle && !r.enabled ? 0.5 : undefined }}>
              {toggle && (
                <Table.Td ta="center">
                  {!blank && <Checkbox size="xs" checked={r.enabled} onChange={(e) => set(i, { enabled: e.currentTarget.checked })} aria-label="Enabled" style={{ display: 'inline-block' }} />}
                </Table.Td>
              )}
              <Table.Td>
                <TextInput variant="unstyled" px={8} styles={cell} placeholder={blank ? `Add ${keyLabel.toLowerCase()}` : ''} value={r.key} readOnly={fixedKeys} onChange={(e) => set(i, { key: e.currentTarget.value })} aria-label={keyLabel} />
              </Table.Td>
              <Table.Td>
                {secret
                  ? <PasswordInput variant="unstyled" px={8} styles={cell} value={r.value} onChange={(e) => set(i, { value: e.currentTarget.value })} aria-label="Value" />
                  : <TextInput variant="unstyled" px={8} styles={cell} placeholder={blank ? 'Value' : ''} value={r.value} onChange={(e) => set(i, { value: e.currentTarget.value })} aria-label="Value" />}
              </Table.Td>
              {(secrets || !fixedKeys) && (
                <Table.Td>
                  {!blank && (
                    <span style={{ display: 'flex', justifyContent: 'center', gap: 2 }}>
                      {secrets && (
                        <Tooltip label={secret ? 'Secret (masked) - click to make plain' : 'Mark as secret'} openDelay={400}>
                          <ActionIcon variant="subtle" color={secret ? 'cobalt' : 'gray'} size="sm" onClick={() => set(i, { type: secret ? 'default' : 'secret' })} aria-label="Toggle secret">{Icons.lock(secret)}</ActionIcon>
                        </Tooltip>
                      )}
                      {!fixedKeys && (
                        <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove">{Icons.trash()}</ActionIcon>
                      )}
                    </span>
                  )}
                </Table.Td>
              )}
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}
