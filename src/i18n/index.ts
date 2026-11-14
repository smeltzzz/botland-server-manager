import { useSyncExternalStore } from 'react';
import en from './en.json';
import locales from './locales.json';

export type MessageKey = keyof typeof en;
export interface LocaleInfo { id: string; label: string; dir: 'ltr' | 'rtl'; userFacing: boolean }

export const LOCALES = locales as LocaleInfo[];
export const DEFAULT_LOCALE = 'en';
const messages: Record<string, Record<string, string>> = { en: en as Record<string, string> };
let current: string = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

function isPseudo(id: string) { return id === 'pseudo' || id === 'pseudo-rtl'; }
export function localeInfo(id: string): LocaleInfo {
  return LOCALES.find(locale => locale.id === id) || LOCALES[0];
}
export function isRtl(id: string) { return localeInfo(id).dir === 'rtl'; }

// Pseudo-localisation makes layout expansion and RTL mirroring testable
// without shipping a machine translation. Hidden from the language picker.
const accents: Record<string, string> = {
  a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý',
  A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú', Y: 'Ý',
};
function pseudoValue(value: string) {
  const accented = value.replace(/[aeiouyAEIOUY]/g, char => accents[char] || char);
  // Add roughly 20% more width so truncation and overflow show up.
  return `⟦${accented.split(' ').map(word => `${word}${'·'.repeat(Math.ceil(word.length / 5))}`).join(' ')}⟧`;
}

function interpolate(value: string, vars?: Record<string, string | number>) {
  if (!vars) return value;
  return value.replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match);
}

export function translate(key: string, vars?: Record<string, string | number>) {
  const value = messages[current]?.[key] ?? messages[DEFAULT_LOCALE]?.[key] ?? key;
  return interpolate(isPseudo(current) ? pseudoValue(value) : value, vars);
}

export function t(key: MessageKey, vars?: Record<string, string | number>) {
  return translate(key, vars);
}

// Optional lookup for data supplied by the main process (schema field labels,
// choices, section names). English falls back to the label main already sent.
export function translateOptional(key: string): string | null {
  const value = messages[current]?.[key] ?? messages[DEFAULT_LOCALE]?.[key];
  if (!value) return null;
  return isPseudo(current) ? pseudoValue(value) : value;
}

export function tp(one: MessageKey, other: MessageKey, count: number, vars?: Record<string, string | number>) {
  return t(plural(count) === 'one' ? one : other, { ...vars, count });
}

function plural(count: number) {
  const tag = isPseudo(current) ? DEFAULT_LOCALE : current;
  try { return new Intl.PluralRules(tag).select(count); }
  catch { return count === 1 ? 'one' : 'other'; }
}

export function localeTag() { return isPseudo(current) ? DEFAULT_LOCALE : current; }

export function applyDocumentLocale(id = current) {
  if (typeof document === 'undefined') return;
  const info = localeInfo(id);
  document.documentElement.lang = isPseudo(id) ? 'en' : info.id;
  document.documentElement.dir = info.dir;
}

export function getLocale() { return current; }
export function setLocale(id: string) {
  const next = LOCALES.some(locale => locale.id === id) ? id : DEFAULT_LOCALE;
  if (next === current) { applyDocumentLocale(next); return; }
  current = next;
  applyDocumentLocale(next);
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useLocale() { return useSyncExternalStore(subscribe, getLocale, getLocale); }

applyDocumentLocale();
