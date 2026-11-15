import { useSyncExternalStore } from 'react';
import type { Game, GameId, LogEntry } from './types';

// Live console lines live outside React state so an 80 ms log flush only
// re-renders the console that shows them, not the whole App tree. Snapshots
// still carry logs; each fresh snapshot reseeds this store.
const LIMIT = 120;
const empty: LogEntry[] = [];
const lines = new Map<GameId, LogEntry[]>();
const listeners = new Set<() => void>();

function notify() { for (const listener of listeners) listener(); }

export function seedLogs(games: Pick<Game, 'id' | 'logs'>[]) {
  let changed = false;
  for (const game of games) {
    if (lines.get(game.id) !== game.logs) { lines.set(game.id, game.logs); changed = true; }
  }
  if (changed) notify();
}

function same(a: LogEntry, b: LogEntry) { return a.at === b.at && a.message === b.message && a.source === b.source; }

// Longest k where the last k stored lines equal the first k incoming lines.
function overlap(current: LogEntry[], entries: LogEntry[]) {
  for (let k = Math.min(current.length, entries.length); k > 0; k--) {
    let match = true;
    for (let i = 0; i < k && match; i++) match = same(current[current.length - k + i], entries[i]);
    if (match) return k;
  }
  return 0;
}

export function appendLogs(batch: Partial<Record<GameId, LogEntry[]>>) {
  let changed = false;
  for (const [id, entries] of Object.entries(batch) as [GameId, LogEntry[] | undefined][]) {
    if (!entries?.length) continue;
    const current = lines.get(id) || empty;
    // A snapshot that arrived while this batch was queued may already hold its
    // first lines; skip that overlap so a line is never shown twice.
    const fresh = entries.slice(overlap(current, entries));
    if (!fresh.length) continue;
    lines.set(id, [...current, ...fresh].slice(-LIMIT));
    changed = true;
  }
  if (changed) notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useGameLogs(id: GameId): LogEntry[] {
  return useSyncExternalStore(subscribe, () => lines.get(id) || empty);
}
