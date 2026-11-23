import { createContext, useContext } from 'react';
import { notifications } from '@mantine/notifications';
import type { Collection, Environment, Globals, Id } from '../../shared/model';

export interface AppData {
  collections: Collection[];
  environments: Environment[];
  globals: Globals;
  activeEnvId: Id | null;
  setActiveEnvId: (id: Id | null) => void;
  /** Selected row in the environments drawer: an environment id or 'globals'. */
  envSelection: string | null;
  editEnvironment: (id: string | null) => void; // a non-null id opens the environments drawer
  /** Unsaved edits by key (request id, environment id, 'vars:<collectionId>', 'globals'). */
  drafts: Record<string, unknown>;
  setDraft: (key: string, value: unknown) => void; // undefined = discard
  /** After a save: discards the draft only if it is still `sent`, so edits made while saving are kept. */
  discardDraft: (key: string, sent: unknown) => void;
  reload: () => Promise<void>;
  refreshAfterRun: (collectionId: Id) => Promise<void>;
  /** Saves `update(latest)`: applied to the current state (saves run one after another), so concurrent edits of other parts are kept. */
  saveCollection: (id: Id, update: (latest: Collection) => Collection) => Promise<void>;
  deleteCollection: (id: Id) => Promise<void>;
  /** Runs `fn` after every queued save, refresh and delete. */
  enqueue: <T>(fn: () => Promise<T>) => Promise<T>;
  saveEnvironment: (e: Environment) => Promise<void>;
  saveGlobals: (g: Globals) => Promise<void>;
  openImport: () => void;
  /** One run at a time across screens (parallel runs would race on env variables): false = another run holds it. */
  claimRun: () => boolean;
  releaseRun: () => void;
  busy: boolean; // a run holds the claim
  /** Drops shown run results of these request ids (deleted or overwritten by an import). */
  forgetResults: (requestIds: Id[]) => void;
  /** Registers a screen's results store; returns the unsubscribe. */
  onForgetResults: (fn: (requestIds: Id[]) => void) => () => void;
}

export const AppContext = createContext<AppData>(null!);
export const useApp = () => useContext(AppContext);

/** Draft of `saved` kept in the app context, so switching views does not lose edits. */
export function useDraft<T>(key: string, saved: T): [value: T, update: (next: T) => void, dirty: boolean] {
  const { drafts, setDraft } = useApp();
  const dirty = key in drafts;
  const value = dirty ? (drafts[key] as T) : saved;
  const update = (next: T) => setDraft(key, JSON.stringify(next) === JSON.stringify(saved) ? undefined : next);
  return [value, update, dirty];
}

/** Active environment id for a run, undefined when none is selected or it was deleted. */
export const runEnvironmentId = (a: AppData) => (a.environments.some((e) => e.id === a.activeEnvId) ? a.activeEnvId ?? undefined : undefined);

/** A Mantine modal or drawer is open: hotkeys of the panes behind it must not fire. */
export const modalOpen = () => !!document.querySelector('[aria-modal="true"]');

export function notifyError(e: unknown) {
  notifications.show({ color: 'stop', title: 'Error', message: e instanceof Error ? e.message : String(e) });
}
