import { useState, type ReactNode } from 'react';
import { Button, Group, Kbd, Modal, Stack, Text } from '@mantine/core';

const svg = (d: ReactNode, size = 16) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);

export const Icons = {
  chevron: (open: boolean) => <span className="chevron" data-open={open || undefined}>{svg(<path d="M9 6l6 6-6 6" />, 14)}</span>,
  dots: () => svg(<><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>),
  plus: () => svg(<path d="M12 5v14M5 12h14" />),
  trash: () => svg(<path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />, 15),
  lock: (on: boolean) => svg(on ? <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></> : <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.5-2" /></>, 14),
  sun: () => svg(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>),
  moon: () => svg(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />),
  upload: () => svg(<path d="M12 16V4M7 9l5-5 5 5M4 20h16" />),
  layers: () => svg(<path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5" />, 15),
  play: () => svg(<path d="M7 5l12 7-12 7z" fill="currentColor" />, 14),
  close: () => svg(<path d="M6 6l12 12M18 6L6 18" />, 14),
  edit: () => svg(<path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4" />, 14),
  search: () => svg(<><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>, 14),
};

/** Counter next to a tab or section title; 0 or undefined shows nothing. */
export const countBadge = (c?: ReactNode) => (c === undefined || c === 0 ? null : <span className="section-count">{c}</span>);
export const shortcut = (key: string) => <><Kbd size="xs">Ctrl</Kbd> + <Kbd size="xs">{key}</Kbd></>;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Monochrome method glyph: weight, not color, tells mutating methods apart. */
export function MethodGlyph({ method, w }: { method: string; w?: number }) {
  const m = method.toUpperCase();
  return <span className="method-glyph" data-mutating={MUTATING.has(m) || undefined} style={{ width: w }}>{m}</span>;
}

/** Collapsible inspector section; the body is only mounted when open (keeps closed Monaco editors out of the DOM). */
export function Section({ title, count, defaultOpen = false, children }: {
  title: string; count?: ReactNode; defaultOpen?: boolean; children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="section">
      <button type="button" className="section-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {Icons.chevron(open)}
        <span className="section-title">{title}</span>
        {countBadge(count)}
      </button>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Stack align="center" justify="center" gap="xs" h="100%" p="xl" ta="center">
      <Text size="md" fw={500}>{title}</Text>
      {children}
    </Stack>
  );
}

export function ConfirmModal({ opened, title, message, onConfirm, onClose }: {
  opened: boolean; title: string; message: ReactNode; onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Modal opened={opened} onClose={onClose} title={title} size="sm" centered>
      <Text size="sm">{message}</Text>
      <Group justify="flex-end" mt="lg">
        <Button variant="default" onClick={onClose}>Cancel</Button>
        <Button color="stop" onClick={() => { onConfirm(); onClose(); }} data-autofocus>Delete</Button>
      </Group>
    </Modal>
  );
}
