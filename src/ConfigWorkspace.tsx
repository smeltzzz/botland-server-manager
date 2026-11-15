import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronDown, CircleHelp, ExternalLink, FileText, History, Info, LockKeyhole, Save, Search, ShieldCheck, SlidersHorizontal, Trash2, TriangleAlert, X } from 'lucide-react';
import type { ConfigBackup, ConfigDocument, ConfigField, ConfigPreview, ConfigTarget, Game, MapData } from './types';
import './config.css';
import { t, tp, translateOptional, localeTag } from './i18n';

function fieldLabel(field: ConfigField) { return translateOptional(`schema.field.${field.sourceKey}`) || field.label; }
function fieldHint(field: ConfigField) { return translateOptional(`schema.hint.${field.sourceKey}`) || field.hint; }
function choiceLabel(field: ConfigField, item: { value: string; label: string }) { return translateOptional(`schema.choice.${field.sourceKey}.${item.value}`) || item.label; }
const sectionOrder = ['Server & access', 'Bot population', 'Teams & balance', 'Difficulty', 'Loadouts', 'Bot behavior', 'Host & diagnostics', 'Match rules'];
function messageOf(error: unknown) { return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
function titleForTarget(game: Game, target: ConfigTarget) {
  if (target === 'base') return t('Server & bot configuration');
  return game.id === 'mw3' ? t('MW3 DSR match rules') : t('BO2 game settings');
}
function backupDate(date: string) {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleString(localeTag());
}
// Only changed values are validated or submitted. In particular, an absent
// setting keeps its game default and an empty masked input means “leave alone”.
export function configEdits(document: ConfigDocument | null, draft: Record<string, string>): Record<string, string> {
  if (!document) return {};
  const entryByKey = new Map(document.entries.map(item => [item.key, item]));
  const fieldByKey = new Map(document.fields.map(field => [field.key, field]));
  return Object.fromEntries(Object.entries(draft).filter(([key, value]) => {
    const entry = entryByKey.get(key);
    if (entry?.masked) return value !== '';
    const original = document.values[key] ?? entry?.value ?? fieldByKey.get(key)?.default;
    return value !== (original ?? '');
  }));
}

export function configNumericLimits(field: ConfigField, gameId: Game['id']) {
  const capped = ['mw2', 'mw3', 'bo2'].includes(gameId) && ['sv_maxclients', 'bots_manage_fill'].includes(field.key);
  // The config save path accepts up to four decimal places, not just tenths.
  return { min: field.min, max: capped ? Math.min(field.max ?? 18, 18) : field.max, step: field.type === 'decimal' ? 0.0001 : 1 };
}

export function validateConfigEdits(document: ConfigDocument | null, values: Record<string, string>, gameId: Game['id']): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!document) return errors;
  const fields = new Map(document.fields.map(field => [field.key, field]));
  const entries = new Map(document.entries.map(entry => [entry.key, entry]));
  for (const [key, value] of Object.entries(values)) {
    const field = fields.get(key);
    if (!field || (entries.get(key)?.masked && value === '')) continue;
    const label = fieldLabel(field);
    if (field.type === 'integer' || field.type === 'decimal') {
      const { min, max, step } = configNumericLimits(field, gameId);
      const number = Number(value);
      if (!value.trim()) errors[key] = t('Enter a number for {field}.', { field: label });
      else if (!Number.isFinite(number)) errors[key] = t('{field} must be a finite number.', { field: label });
      else if (field.type === 'integer' && !/^-?\d{1,8}$/.test(value)) errors[key] = t('{field} must be a whole number without decimal or exponent notation.', { field: label });
      else if (field.type === 'decimal' && !/^-?\d{1,6}(?:\.\d{1,4})?$/.test(value)) errors[key] = t('{field} must be a number with at most four decimal places, without exponent notation.', { field: label });
      else if (min !== undefined && number < min) errors[key] = t('{field} must be at least {min}.', { field: label, min });
      else if (max !== undefined && number > max) errors[key] = t('{field} must be no more than {max}.', { field: label, max });
      else if (Math.abs((number - (min ?? 0)) / step - Math.round((number - (min ?? 0)) / step)) > 0.000001) errors[key] = t('{field} must use increments of {step}.', { field: label, step });
    } else if (field.type === 'select' && !field.choices?.some(choice => choice.value === value)) {
      errors[key] = t('Choose a supported value for {field}.', { field: label });
    } else if (field.type === 'text') {
      if (!value.trim() && !field.allowEmpty && !entries.get(key)?.masked) errors[key] = t('{field} cannot be blank.', { field: label });
      else if (value.length > (field.maxLength ?? 256)) errors[key] = t('{field} must be no more than {max} characters.', { field: label, max: field.maxLength ?? 256 });
    }
  }
  const current = (key: string) => values[key] ?? document.values[key] ?? (entries.get(key)?.masked ? undefined : entries.get(key)?.value);
  const edited = (key: string) => Object.hasOwn(values, key);
  const mark = (keys: string[], message: string) => {
    for (const key of keys) if (!errors[key] && (fields.has(key) || entries.has(key))) errors[key] = message;
  };
  // Match the backend's safe slot fallback when the file omits the slot count.
  // Do not reject an unrelated edit just because an existing value is unusual.
  if ((edited('sv_maxclients') || edited('bots_manage_fill')) && !errors.sv_maxclients && !errors.bots_manage_fill) {
    const cap = ['mw2', 'mw3', 'bo2'].includes(gameId) ? 18 : 64;
    const rawSlots = current('sv_maxclients') ?? '';
    const slots = /^\s*\d+\s*$/.test(rawSlots) ? Math.min(Number(rawSlots), cap) : cap;
    const fill = Number(current('bots_manage_fill') ?? 0);
    if (Number.isFinite(fill) && fill > slots) mark(['sv_maxclients', 'bots_manage_fill'], t('Bot target cannot exceed player slots. Increase Player slots or reduce Fill target.'));
  }
  if ((edited('bots_skill_min') || edited('bots_skill_max')) && !errors.bots_skill_min && !errors.bots_skill_max) {
    const min = Number(current('bots_skill_min') ?? fields.get('bots_skill_min')?.default ?? 1);
    const max = Number(current('bots_skill_max') ?? fields.get('bots_skill_max')?.default ?? 7);
    if (Number.isFinite(min) && Number.isFinite(max) && min > max) mark(['bots_skill_min', 'bots_skill_max'], t('Minimum bot skill cannot exceed maximum bot skill.'));
  }
  return errors;
}

export function applyConfigValue(document: ConfigDocument | null, previous: Record<string, string>, key: string, next: string) {
  const updated = { ...previous, [key]: next };
  // Keep Guided and All existing settings identical: a newly hidden dependent
  // field must not retain an edit that would still be written to the file.
  for (const other of document?.fields || []) {
    if (other.dependsOn?.key !== key || other.dependsOn.value === next) continue;
    if (document && Object.hasOwn(document.values, other.key)) updated[other.key] = document.values[other.key]!;
    else delete updated[other.key];
  }
  return updated;
}

export function reconcileBackupSelection(selected: string[], backups: ConfigBackup[]) {
  const surviving = new Set(backups.map(backup => backup.id));
  return [...new Set(selected)].filter(id => surviving.has(id));
}

function revealFocus(element: HTMLElement | null) {
  element?.focus({ preventScroll: true });
  element?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}
function focusableTrigger(element: HTMLElement | null): element is HTMLElement {
  return !!element?.isConnected && !element.matches(':disabled, [aria-disabled="true"]') && !element.closest('[inert], [hidden], [aria-hidden="true"]') && element.getClientRects().length > 0 && window.getComputedStyle(element).visibility !== 'hidden';
}
function byteSize(bytes: number) {
  return tp('{size} byte', '{size} bytes', bytes, { size: bytes.toLocaleString(localeTag()) });
}

type RestoreReview = { id: string; date: string; token: string; currentBytes: number; backupBytes: number; missing: boolean; context: string };
type ConfigOperation = 'review' | 'save' | 'reload-saved' | 'preview-restore' | 'restore' | 'prune' | null;

export default function ConfigWorkspace({ game, maps, refreshRevision, onDirtyChange, onBusyChange }: { game: Game; maps?: MapData | undefined; refreshRevision: number; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void }) {
  const [target, setTarget] = useState<ConfigTarget>('base');
  const [mode, setMode] = useState(game.options.mode);
  const [view, setView] = useState<'guided' | 'advanced'>('guided');
  const [document, setDocument] = useState<ConfigDocument | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const requestId = useRef(0);
  const backupRequest = useRef(0);
  const pathKey = JSON.stringify([game.id, game.gamePath, game.configPath]);
  const contextKey = JSON.stringify([game.id, game.gamePath, game.configPath, target, mode, refreshRevision]);
  const currentContext = useRef(contextKey);
  const loadedPath = useRef(pathKey);
  currentContext.current = contextKey;
  // State updates are asynchronous; a ref blocks a second click in the same tick.
  const working = useRef(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const dialogExit = useRef<'trigger' | 'heading' | 'notice'>('trigger');
  const mainRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const recoveryInputRef = useRef<HTMLInputElement | null>(null);
  const [search, setSearch] = useState('');
  const [recoveryMode, setRecoveryMode] = useState('');
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [validationAttempt, setValidationAttempt] = useState(0);
  // Start in the loading state so the "could not be opened" message never flashes on open.
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<ConfigOperation>(null);
  const busy = operation !== null;
  const [notice, setNotice] = useState<{ text: string; error: boolean; focus?: boolean } | null>(null);
  const [pending, setPending] = useState<{ values: Record<string, string>; preview: ConfigPreview; path: string } | null>(null);
  const [backups, setBackups] = useState<ConfigBackup[]>([]);
  const [backupScope, setBackupScope] = useState('');
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [selectedBackups, setSelectedBackups] = useState<string[]>([]);
  const [restoreReview, setRestoreReview] = useState<RestoreReview | null>(null);
  const [pathConflict, setPathConflict] = useState(false);
  const [reloadRevision, setReloadRevision] = useState(0);
  const supportsModeFile = game.id === 'mw3' || game.id === 'bo2';
  useEffect(() => { setTarget('base'); setMode(game.options.mode); setSearch(''); setRecoveryMode(''); setRecoveryError(null); }, [game.id]);
  useEffect(() => {
    let active = true;
    const request = ++requestId.current;
    setPending(null); setRestoreReview(null); setValidationAttempt(0);
    setBackups([]); setSelectedBackups([]); setBackupError(null);
    // A folder change can arrive from a state event, without the editor's switch confirmation.
    // Keep the old draft visible until the user explicitly chooses to discard it.
    if (document && changeCount && loadedPath.current !== pathKey) {
      setPathConflict(true); setLoading(false); setBackupLoading(false);
      return () => { active = false; requestId.current++; backupRequest.current++; };
    }
    if (pathConflict && document && loadedPath.current === pathKey) {
      setPathConflict(false); loadBackups(request);
      return () => { active = false; requestId.current++; backupRequest.current++; };
    }
    setPathConflict(false); setLoading(true); setDocument(null); setNotice(null);
    loadBackups(request);
    window.manager.document(game.id, target, mode).then(result => {
      if (!active || request !== requestId.current || contextKey !== currentContext.current) return;
      loadedPath.current = pathKey;
      setDocument(result); setDraft(result.values);
    }).catch(error => { if (active && request === requestId.current && contextKey === currentContext.current) setNotice({ text: messageOf(error), error: true }); })
      .finally(() => { if (active && request === requestId.current && contextKey === currentContext.current) setLoading(false); });
    return () => { active = false; requestId.current++; backupRequest.current++; };
  }, [game.id, game.gamePath, game.configPath, target, mode, refreshRevision, reloadRevision]);
  async function loadBackups(request = requestId.current) {
    const listRequest = ++backupRequest.current;
    setBackupLoading(true);
    try {
      const list = await window.manager.listConfigBackups(game.id, target, mode);
      if (request !== requestId.current || listRequest !== backupRequest.current || contextKey !== currentContext.current) return false;
      setBackups(list); setBackupScope(contextKey); setBackupError(null);
      setSelectedBackups(previous => reconcileBackupSelection(previous, list));
      return true;
    } catch (error) {
      if (request === requestId.current && listRequest === backupRequest.current && contextKey === currentContext.current) setBackupError(messageOf(error));
      return false;
    } finally {
      if (request === requestId.current && listRequest === backupRequest.current && contextKey === currentContext.current) setBackupLoading(false);
    }
  }
  const guided = useMemo(() => document?.fields.filter(field => !field.presentOnly || field.key in document.values).filter(field => {
    if (!field.dependsOn) return true;
    const current = draft[field.dependsOn.key] ?? document.values[field.dependsOn.key] ?? document.fields.find(other => other.key === field.dependsOn?.key)?.default;
    return current === field.dependsOn.value;
  }).filter(field => `${fieldLabel(field)} ${field.key} ${fieldHint(field) || ''}`.toLowerCase().includes(search.trim().toLowerCase())) || [], [document, draft, search]);
  // Config keys keep their file casing (sv_hostname, g_TeamName_Allies); match without case.
  const entries = useMemo(() => document?.entries.filter(entry => entry.key.toLowerCase().includes(search.trim().toLowerCase()) || (document.fields.find(field => field.key === entry.key) ? fieldLabel(document.fields.find(field => field.key === entry.key)!) : '').toLowerCase().includes(search.trim().toLowerCase())) || [], [document, search]);
  const edits = useMemo(() => configEdits(document, draft), [document, draft]);
  const validationErrors = useMemo(() => validateConfigEdits(document, edits, game.id), [document, edits, game.id]);
  const changeCount = Object.keys(edits).length;
  const visibleBackups = backupScope === contextKey ? backups : [];
  const activeRestore = restoreReview?.context === contextKey ? restoreReview : null;
  useEffect(() => { onDirtyChange(changeCount > 0); }, [changeCount, onDirtyChange]);
  useEffect(() => { onBusyChange(busy || !!pending || !!restoreReview); }, [busy, pending, restoreReview, onBusyChange]);
  useEffect(() => () => { onDirtyChange(false); onBusyChange(false); }, [onDirtyChange, onBusyChange]);
  // Native dialogs trap focus. Their trigger is captured before the async
  // preview disables it, not here after the request has already completed.
  const reviewOpen = !!pending || !!activeRestore;
  useEffect(() => {
    if (!reviewOpen) return;
    const dialog = dialogRef.current;
    const trigger = dialogTrigger.current;
    const openingContext = currentContext.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const heading = dialog.querySelector('h2');
    if (heading instanceof HTMLElement) { heading.tabIndex = -1; heading.focus(); }
    else dialog.querySelector('button')?.focus();
    return () => {
      if (dialog.open) dialog.close();
      const destination = dialogExit.current;
      // Result/error notices have their own focus effect. Never return to the
      // now-disabled Review button after a successful write.
      if (destination === 'notice') return;
      window.requestAnimationFrame(() => {
        if (openingContext !== currentContext.current || !headingRef.current?.isConnected || dialogRef.current?.open) return;
        if (destination === 'trigger' && focusableTrigger(trigger)) {
          trigger.focus({ preventScroll: true });
          if (window.document.activeElement === trigger) { trigger.scrollIntoView({ block: 'nearest', behavior: 'instant' }); return; }
        }
        revealFocus(headingRef.current);
      });
    };
  }, [reviewOpen]);
  // Errors and completed writes may originate below the fold. Run after modal
  // cleanup so focus is visible and cannot be stolen by trigger restoration.
  useEffect(() => {
    if (!notice?.error && !notice?.focus) return;
    const frame = window.requestAnimationFrame(() => revealFocus(noticeRef.current || headingRef.current));
    return () => window.cancelAnimationFrame(frame);
  }, [notice]);
  useEffect(() => {
    if (!validationAttempt) return;
    const field = mainRef.current?.querySelector<HTMLInputElement | HTMLSelectElement>('[data-config-key][aria-invalid="true"]');
    if (field) revealFocus(field);
  }, [validationAttempt]);
  function canSwitch() {
    if (busy || pending || restoreReview || working.current) return false;
    if (changeCount && !window.confirm(t('Discard unsaved configuration changes?'))) return false;
    if (changeCount) setDraft(document?.values || {});
    return true;
  }
  async function review(trigger: HTMLButtonElement) {
    if (!game.installed || !document || !changeCount || busy || working.current || pathConflict || loadedPath.current !== pathKey || pending || restoreReview) return;
    if (Object.keys(validationErrors).length) {
      setNotice(null); setSearch('');
      // A filtered/hidden field still needs a reachable error target. Prefer
      // the current view; fall back only if it cannot render any invalid field.
      if (view === 'advanced' && !document.entries.some(entry => validationErrors[entry.key])) setView('guided');
      else if (view === 'guided' && !document.fields.some(field => validationErrors[field.key] && (!field.presentOnly || field.key in document.values) && (!field.dependsOn || (draft[field.dependsOn.key] ?? document.values[field.dependsOn.key] ?? document.fields.find(other => other.key === field.dependsOn?.key)?.default) === field.dependsOn.value))) setView('advanced');
      setValidationAttempt(previous => previous + 1);
      return;
    }
    dialogTrigger.current = trigger; dialogExit.current = 'trigger';
    working.current = true;
    const request = requestId.current;
    const values = { ...edits };
    const file = document.path;
    setOperation('review'); setNotice(null);
    try {
      const preview = await window.manager.previewSettings(game.id, target, mode, values, file);
      if (request !== requestId.current || contextKey !== currentContext.current) return;
      if (!preview.changes.length) return setNotice({ text: t('These settings already have the requested values.'), error: false, focus: true });
      setPending({ preview, values, path: file });
    } catch (error) { if (request === requestId.current && contextKey === currentContext.current) setNotice({ text: messageOf(error), error: true }); }
    finally { working.current = false; setOperation(null); }
  }
  async function commit() {
    if (!game.installed || !pending || busy || working.current || pathConflict || loadedPath.current !== pathKey) return;
    working.current = true;
    const request = requestId.current;
    setOperation('save');
    try {
      const result = await window.manager.commitSettings(game.id, target, mode, pending.values, pending.preview.token, pending.path);
      if (request !== requestId.current || contextKey !== currentContext.current) return;
      dialogExit.current = 'notice';
      setDocument(result); setDraft(result.values); setPending(null); setValidationAttempt(0);
      loadBackups(request);
      setNotice({ text: tp('Saved {count} change; the original file was backed up. Takes effect the next time the server starts.', 'Saved {count} changes; the original file was backed up. Takes effect the next time the server starts.', pending.preview.changes.length), error: false, focus: true });
    } catch (error) {
      if (request === requestId.current && contextKey === currentContext.current) {
        const message = messageOf(error);
        dialogExit.current = 'notice';
        setPending(null);
        // The main process explicitly reports an already-completed save. Drop
        // the submitted draft before recovery so the write cannot be retried.
        if (/^The configuration was saved, but it could not be reloaded/i.test(message)) {
          dialogExit.current = 'heading';
          setDocument(null); setDraft({}); setLoading(true); setOperation('reload-saved');
          loadBackups(request);
          let text = message;
          try {
            const result = await window.manager.document(game.id, target, mode);
            if (request !== requestId.current || contextKey !== currentContext.current) return;
            setDocument(result); setDraft(result.values); setValidationAttempt(0);
            text = t('{message} Settings have now been reloaded; the save already completed.', { message });
          } catch (reloadError) {
            text = t('{message} Retry loading the settings before editing again: {detail}', { message, detail: messageOf(reloadError) });
          } finally {
            if (request === requestId.current && contextKey === currentContext.current) setLoading(false);
          }
          if (request === requestId.current && contextKey === currentContext.current) setNotice({ text, error: true });
        } else setNotice({ text: message, error: true });
      }
    }
    finally { working.current = false; setOperation(null); }
  }
  async function previewRestore(backup: ConfigBackup, trigger: HTMLButtonElement) {
    if (busy || pending || restoreReview || working.current || backupLoading || backupError || backupScope !== contextKey || !visibleBackups.some(item => item.id === backup.id)) return;
    dialogTrigger.current = trigger; dialogExit.current = 'trigger';
    working.current = true;
    const request = requestId.current;
    setOperation('preview-restore'); setNotice(null);
    try {
      const preview = await window.manager.previewConfigRestore(game.id, target, mode, backup.id);
      if (request !== requestId.current || contextKey !== currentContext.current) return;
      if (!preview.summary.changed && !preview.summary.missing) {
        setNotice({ text: t('The current file already matches this backup.'), error: false, focus: true });
        return;
      }
      // Never put preview.summary.contents in state or in the DOM: backups can contain secrets.
      setRestoreReview({ id: backup.id, date: backup.date, token: preview.token, currentBytes: preview.summary.currentBytes, backupBytes: preview.summary.backupBytes, missing: preview.summary.missing === true, context: contextKey });
    } catch (error) {
      if (request === requestId.current && contextKey === currentContext.current) setNotice({ text: messageOf(error), error: true });
    } finally {
      working.current = false;
      setOperation(null);
    }
  }
  async function restoreBackup() {
    if (!game.installed || !activeRestore || busy || working.current) return;
    if (changeCount && !window.confirm(t('Restoring this backup will discard your unsaved configuration edits. Continue?'))) return;
    working.current = true;
    const request = requestId.current;
    const { id, token } = activeRestore;
    setOperation('restore'); setNotice(null);
    try {
      if (contextKey !== currentContext.current) return;
      const restored = await window.manager.restoreConfigBackup(game.id, target, mode, id, token);
      if (request !== requestId.current || contextKey !== currentContext.current) return;
      dialogExit.current = 'heading';
      setRestoreReview(null);
      setDocument(null); setDraft({}); setLoading(true); setSelectedBackups([]); setValidationAttempt(0);
      loadBackups(request);
      try {
        const result = await window.manager.document(game.id, target, mode);
        if (request !== requestId.current || contextKey !== currentContext.current) return;
        loadedPath.current = pathKey;
        setDocument(result); setDraft(result.values);
        setNotice({ text: restored.backupId === null ? t('Missing configuration recreated from backup. There was no current file to back up. Takes effect the next time the server starts.') : t('Configuration restored. The previous file was backed up. Takes effect the next time the server starts.'), error: false, focus: true });
      } catch (error) {
        if (request === requestId.current && contextKey === currentContext.current) setNotice({ text: restored.backupId === null ? t('Missing configuration recreated from backup; there was no current file to back up. Settings could not be reloaded: {message}', { message: messageOf(error) }) : t('Backup restored, but settings could not be reloaded: {message}', { message: messageOf(error) }), error: true });
      }
    } catch (error) {
      if (request === requestId.current && contextKey === currentContext.current) { dialogExit.current = 'notice'; setRestoreReview(null); setNotice({ text: messageOf(error), error: true }); }
    } finally {
      working.current = false;
      if (request === requestId.current && contextKey === currentContext.current) setLoading(false);
      setOperation(null);
    }
  }
  async function pruneBackups() {
    if (!selectedBackups.length || busy || pending || restoreReview || working.current || backupLoading || backupError || backupScope !== contextKey) return;
    const ids = reconcileBackupSelection(selectedBackups, visibleBackups);
    if (!ids.length || !window.confirm(tp('Permanently delete {count} selected configuration backup? This cannot be undone.', 'Permanently delete {count} selected configuration backups? This cannot be undone.', ids.length))) return;
    working.current = true;
    const request = requestId.current;
    setOperation('prune'); setNotice(null);
    try {
      if (contextKey !== currentContext.current) return;
      const result = await window.manager.pruneConfigBackups(game.id, target, mode, ids);
      if (request !== requestId.current || contextKey !== currentContext.current) return;
      setSelectedBackups([]);
      await loadBackups(request);
      if (request === requestId.current && contextKey === currentContext.current) setNotice({ text: tp('Removed {count} configuration backup.', 'Removed {count} configuration backups.', result.removed), error: false, focus: true });
    } catch (error) {
      if (request === requestId.current && contextKey === currentContext.current) {
        // A prune can fail after deleting some files. Refresh once and keep only
        // surviving selected IDs; never retry this destructive action for them.
        const refreshed = await loadBackups(request);
        if (request === requestId.current && contextKey === currentContext.current) setNotice({ text: refreshed ? t('Backup deletion stopped. {message} The remaining backups have been refreshed; review the selection before deleting again.', { message: messageOf(error) }) : t('Backup deletion stopped. {message} Reload the backup list to see which files remain before deleting again.', { message: messageOf(error) }), error: true });
      }
    } finally {
      working.current = false;
      setOperation(null);
    }
  }
  function updateValue(key: string, next: string) {
    setDraft(previous => applyConfigValue(document, previous, key, next));
  }
  function fieldControl(field: ConfigField) {
    const value = draft[field.key] ?? (field.default ?? '');
    const setValue = (next: string) => updateValue(field.key, next);
    const id = `config-${target}-${field.key}`;
    const accessibility = { id, 'data-config-key': field.key, 'aria-invalid': !!validationErrors[field.key], 'aria-describedby': `${id}-hint${validationErrors[field.key] ? ` ${id}-error` : ''}` };
    if (field.type === 'select') return <select {...accessibility} value={value} disabled={busy || !!pending || !!restoreReview} onChange={event => setValue(event.target.value)}>{!field.choices?.some(item => item.value === value) && <option value={value}>{value || t('Not set')}</option>}{field.choices?.map(item => <option value={item.value} key={item.value}>{choiceLabel(field, item)}</option>)}</select>;
    const { min, max, step } = configNumericLimits(field, game.id);
    return <input {...accessibility} type={field.type === 'text' ? 'text' : 'number'} step={field.type === 'text' ? undefined : step} min={min} max={max} maxLength={field.maxLength} value={value} disabled={busy || !!pending || !!restoreReview} onChange={event => setValue(event.target.value)} />;
  }
  function cancelReview() {
    if (busy || working.current) return;
    dialogExit.current = 'trigger';
    setPending(null); setRestoreReview(null);
  }
  function showModeBackups() {
    if (busy || pending || restoreReview || working.current) return;
    const name = recoveryMode.trim();
    if (!/^[a-z0-9_]+$/i.test(name)) {
      setRecoveryError(t('Use only letters, numbers and underscores, without a file extension.'));
      window.requestAnimationFrame(() => revealFocus(recoveryInputRef.current));
      return;
    }
    if (!canSwitch()) return;
    setRecoveryError(null);
    // This is an editor/recovery target only. Never save it as a launch mode or
    // add it to the discovered playable-mode list used by Maps & modes.
    if (name === mode) setReloadRevision(previous => previous + 1);
    else setMode(name);
  }
  const activityMessage = operation === 'review' ? t('Preparing configuration preview…')
    : operation === 'save' ? t('Saving configuration… Please wait; this write cannot be canceled.')
      : operation === 'reload-saved' ? t('The configuration was saved. Reloading settings…')
        : operation === 'preview-restore' ? t('Preparing backup restore preview…')
          : operation === 'restore' ? t('Restoring configuration… Please wait; this write cannot be canceled.')
            : operation === 'prune' ? t('Deleting selected configuration backups…') : '';
  const backupBusy = backupLoading || operation === 'preview-restore' || operation === 'restore' || operation === 'prune';
  const unavailableMode = target === 'mode' && !!maps && !maps.modes.some(item => item.value === mode);
  const modeFile = game.id === 'mw3' ? `admin\\${mode}.dsr` : `main\\gamesettings\\${mode}.cfg`;
  const filePath = document?.path || (target === 'mode' ? modeFile : game.configPath);
  return <div className="config-layout" role="tabpanel" id="panel-configuration" aria-labelledby="tab-configuration">
    <div className="config-activity" role="status" aria-live="polite" aria-atomic="true">{!reviewOpen && activityMessage}</div>
    <section ref={mainRef} className="panel config-main" aria-labelledby="config-heading" aria-busy={loading || busy}>
      <div className="config-title"><div className="panel-icon"><SlidersHorizontal size={19} /></div><div><span className="section-kicker">{t('MAKE IT YOURS')}</span><h2 id="config-heading" ref={headingRef} tabIndex={-1}>{titleForTarget(game, target)}</h2></div></div>
      <p className="panel-description">{t('Game-specific controls built around this title’s settings. Review edits before saving; existing files are backed up before they are replaced.')}</p>
      {supportsModeFile && <>
        <div className="config-targets" role="group" aria-label={t('Configuration file')}>
          <button className={target === 'base' ? 'active' : ''} aria-pressed={target === 'base'} disabled={busy || !!pending || !!activeRestore} onClick={() => { if (target !== 'base' && canSwitch()) setTarget('base'); }}>{t('Server & bots')}</button>
          <button className={target === 'mode' ? 'active' : ''} aria-pressed={target === 'mode'} disabled={busy || !!pending || !!activeRestore} onClick={() => { if (target !== 'mode' && canSwitch()) setTarget('mode'); }}>{t('Mode rules')}</button>
          {target === 'mode' && <label><span>{t('RULESET')}</span><select value={mode} disabled={busy || !!pending || !!activeRestore} onChange={event => { if (event.target.value !== mode && canSwitch()) setMode(event.target.value); }}>
            {!maps?.modes.some(item => item.value === mode) && <option value={mode}>{maps ? t('{mode} (unavailable; recovery only)', { mode }) : mode}</option>}
            {maps?.modes.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}
          </select><ChevronDown size={14} /></label>}
        </div>
        {target === 'mode' && <>
          {unavailableMode && <p className="config-recovery-note">{t('This ruleset is not in the playable mode list. You can still recover its named file from Backups. Selecting it here does not change the launch mode.')}</p>}
          <details className="config-mode-recovery">
            <summary>{t('Recover a missing or damaged mode file')}</summary>
            <p>{game.id === 'mw3' ? t('Enter the ruleset file name without .dsr to view its backups, even when the file is missing. This does not change the launch mode.') : t('Enter the ruleset file name without .cfg to view its backups, even when BO2 cannot discover the damaged or missing file. This does not change the launch mode.')}</p>
            <div className="config-recovery-controls"><label htmlFor="config-recovery-mode">{t('Ruleset file name')}</label><input id="config-recovery-mode" ref={recoveryInputRef} type="text" spellCheck={false} value={recoveryMode} placeholder={mode} disabled={busy || !!pending || !!activeRestore} aria-invalid={!!recoveryError} aria-describedby={recoveryError ? 'config-recovery-error' : undefined} onChange={event => { setRecoveryMode(event.target.value); setRecoveryError(null); }} /><button className="outline-button" disabled={busy || !!pending || !!activeRestore} onClick={showModeBackups}>{t('View mode backups')}</button></div>
            {recoveryError && <p className="config-field-error" id="config-recovery-error" role="alert">{recoveryError}</p>}
          </details>
        </>}
      </>}
      <div className="config-toolbar"><div className="config-switch" role="group" aria-label={t('Configuration view')}><button className={view === 'guided' ? 'selected' : ''} aria-pressed={view === 'guided'} disabled={busy || !!pending || !!activeRestore} onClick={() => { setView('guided'); setSearch(''); }}>{t('Guided settings')}</button><button className={view === 'advanced' ? 'selected' : ''} aria-pressed={view === 'advanced'} disabled={busy || !!pending || !!activeRestore} onClick={() => { setView('advanced'); setSearch(''); }}>{t('All existing settings')} <span>{document?.entries.length || 0}</span></button></div><div className="config-search"><Search size={15} /><input type="search" disabled={busy || !!pending || !!activeRestore} aria-label={t('Search configuration settings')} placeholder={t('Search settings…')} value={search} onChange={event => setSearch(event.target.value)} /></div></div>
      {pathConflict && <div className="config-path-warning" role="alert"><TriangleAlert size={17} /><div><strong>{t('Configuration location changed while you were editing.')}</strong><p>{t('Your unsaved edits are still shown below for reference. Saving to the old location is blocked. Copy anything you need before loading the new file.')}</p><button className="outline-button" disabled={busy || !!pending || !!activeRestore} onClick={() => { if (working.current) return; setDraft(document?.values || {}); setPathConflict(false); setReloadRevision(previous => previous + 1); }}>{t('Discard edits and load new file')}</button></div></div>}
      {notice && <div ref={noticeRef} tabIndex={-1} className={`config-notice ${notice.error ? 'error' : 'success'}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <TriangleAlert size={16} /> : <Check size={16} />}<span>{notice.text}</span><button className="config-notice-dismiss" onClick={() => setNotice(null)} aria-label={t('Dismiss')}><X size={15} /></button></div>}
      {loading && <div className="config-empty" role="status">{t('Loading settings from the installed game…')}</div>}
      {!loading && !document && <div className="config-empty"><FileText size={22} /> {t('The config file could not be opened. Check the game folder on the Overview tab, then retry.')} <button className="inline-link" onClick={() => setReloadRevision(previous => previous + 1)}>{t('Retry')}</button></div>}
      {!loading && document && <>
        {!!validationAttempt && !!Object.keys(validationErrors).length && <p className="config-validation-summary" role="alert">{t('Check the highlighted settings before reviewing your changes.')}</p>}
        {view === 'guided' ? <div className="config-groups">{sectionOrder.map((section, index) => {
          const sectionLabel = translateOptional(`schema.section.${section}`) || section;
          const visible = guided.filter(field => field.section === section);
          if (!visible.length) return null;
          const headingId = `config-section-${index}`;
          return <section className="config-group" key={section} aria-labelledby={headingId}>
            <div className="config-group-title"><h3 id={headingId}>{sectionLabel}</h3><span aria-hidden="true">{visible.length.toString().padStart(2, '0')}</span></div>
            <fieldset className="config-field-grid" aria-labelledby={headingId} disabled={busy || !!pending || !!activeRestore}>{visible.map(field => {
              const id = `config-${target}-${field.key}`;
              return <div className="form-field" key={field.key}>
                <label htmlFor={id}>{fieldLabel(field)}{!(field.key in document.values) && <em aria-hidden="true" title={t('The game currently uses its default until you edit this field.')}>{t('DEFAULT')}</em>}</label>
                <small id={`${id}-hint`}>{fieldHint(field) || field.sourceKey}{!(field.key in document.values) && <span className="sr-only"> {t('The game currently uses its default until you edit this field.')}</span>}</small>
                {fieldControl(field)}
                {validationErrors[field.key] && <small className="config-field-error" id={`${id}-error`}>{validationErrors[field.key]}</small>}
              </div>;
            })}</fieldset>
          </section>;
        })}{!guided.length && <div className="config-empty">{t('No guided settings match this search.')}</div>}</div>
          : <section aria-labelledby="config-existing-heading">
            <h3 className="config-existing-heading" id="config-existing-heading">{t('All existing settings')}</h3>
            <div className="advanced-tip" id="config-sensitive-description"><LockKeyhole size={15} /> {t('Sensitive values are never read into the UI. You may replace them, but the game still stores them in its config and backup files.')}</div>
            <div className="advanced-list" role="group" aria-labelledby="config-existing-heading">{entries.map(entry => {
              const id = `config-advanced-${target}-${entry.key}`;
              const description = [entry.masked ? 'config-sensitive-description' : '', validationErrors[entry.key] ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
              return <div className="advanced-row" key={entry.key}>
                <div><label htmlFor={id}><strong>{entry.key}</strong></label>{entry.count > 1 && <span className="duplicate-tag" title={t('The last active assignment takes effect.')}>{t('DUPLICATE ×')}{entry.count}</span>}{entry.masked && <span title={t('Sensitive value hidden')}><LockKeyhole size={14} /></span>}</div>
                <div className="advanced-value"><input id={id} data-config-key={entry.key} type={entry.masked ? 'password' : 'text'} aria-label={t('Value for {key}', { key: entry.key })} aria-invalid={!!validationErrors[entry.key]} aria-describedby={description} title={entry.key === 'bots_manage_add' ? t('One-shot runtime command; editing its saved value is not supported.') : undefined} disabled={busy || !!pending || !!restoreReview || entry.key === 'bots_manage_add'} placeholder={entry.masked ? t('Replace hidden value') : ''} value={Object.hasOwn(draft, entry.key) ? draft[entry.key] : (entry.masked ? '' : entry.value)} onChange={event => updateValue(entry.key, event.target.value)} />{validationErrors[entry.key] && <small className="config-field-error" id={`${id}-error`}>{validationErrors[entry.key]}</small>}</div>
              </div>;
            })}{!entries.length && <div className="config-empty">{t('No existing settings match this search.')}</div>}</div>
          </section>}
        <div className="config-savebar" aria-busy={operation === 'review'}><span><ShieldCheck size={16} /> {changeCount ? tp('{count} unsaved change', '{count} unsaved changes', changeCount) : t('Changes are backed up before saving.')}</span><button className="button primary-button" disabled={!game.installed || !changeCount || busy || !!pending || !!restoreReview || pathConflict || loadedPath.current !== pathKey} onClick={event => review(event.currentTarget)}><Save size={16} /> {t('Review changes')}</button></div>
      </>}
    </section>
    <aside className="config-aside" aria-label={t('Configuration help and backups')}><div className="panel"><div className="panel-icon featured"><FileText size={19} /></div><h3>{t('Know your config.')}</h3><p>{t('These options are based on the Bot Warfare documentation and settings actually supported by this game. Unrecognized directives and your existing comments are kept.')}</p><div className="config-file-label">{document && (pathConflict || loadedPath.current !== pathKey) ? t('DRAFT FROM PREVIOUS FOLDER') : document ? t('EDITING FILE') : t('RECOVERY FILE')}</div><div className="config-file-path" title={filePath}>{filePath}</div><button className="outline-button full-width" disabled={!game.installed || !document || loading || pathConflict || loadedPath.current !== pathKey || document.target !== target || (target === 'mode' && document.mode !== mode)} title={pathConflict || loadedPath.current !== pathKey ? t('Discard edits and load the new file first; this path is from the previous folder.') : undefined} onClick={() => window.manager.openDocument(game.id, target, mode).catch(error => setNotice({ text: messageOf(error), error: true }))}><ExternalLink size={15} /> {t('Open current file')}</button></div><div className="panel config-backups" role="region" aria-labelledby="config-backups-heading" aria-busy={backupBusy}><div className="config-backups-heading"><History size={18} /><div><span className="section-kicker">{t('CONFIGURATION FILES')}</span><h3 id="config-backups-heading">{t('Backups')}</h3></div></div><p>{target === 'base' ? t('Saved copies of the server config. These are separate from Bot Warfare mod versions. Contents may include passwords; previews show file sizes only.') : t('Saved copies of the {mode} mode file. These are separate from Bot Warfare mod versions. Contents may include passwords; previews show file sizes only.', { mode })}</p>{!document && !loading && <p className="config-backups-recovery">{t('If this file has backups, you can preview and restore them here even when it cannot be opened.')}</p>}{backupLoading && <p className="config-backups-status" role="status">{t('Loading backups…')}</p>}{backupError && <div className="config-backups-error" role="alert">{backupError} <button className="inline-link" disabled={busy || !!pending || !!activeRestore || backupLoading} onClick={() => loadBackups()}>{t('Retry')}</button></div>}{!backupLoading && !backupError && !visibleBackups.length && <p className="config-backups-status">{pathConflict ? t('Load the new file before viewing its backups.') : t('No saved copies for this file yet.')}</p>}{!!visibleBackups.length && <><div className="config-backups-list">{visibleBackups.map(backup => <div className="config-backup" key={backup.id}><label><input type="checkbox" aria-label={t('Select backup {id} for deletion', { id: backup.id })} checked={selectedBackups.includes(backup.id)} disabled={busy || !!pending || !!restoreReview || backupLoading || !!backupError} onChange={event => setSelectedBackups(previous => event.target.checked ? [...new Set([...previous, backup.id])] : previous.filter(id => id !== backup.id))} /><span><strong>{backupDate(backup.date)}</strong><small>{byteSize(backup.bytes)}<br />{t('ID')} <code>{backup.id}</code></small></span></label><button className="outline-button" aria-label={t('Preview restore of backup {id}', { id: backup.id })} disabled={busy || !!pending || !!restoreReview || backupLoading || !!backupError} onClick={event => previewRestore(backup, event.currentTarget)}>{t('Preview restore')}</button></div>)}</div><button className="outline-button full-width config-prune" disabled={!selectedBackups.length || busy || !!pending || !!restoreReview || backupLoading || !!backupError} onClick={pruneBackups}><Trash2 size={14} /> {tp('Delete {count} selected backup', 'Delete {count} selected backups', selectedBackups.length)}</button></>}</div><div className="aside-tip"><Info size={17} /><p>{game.id === 'bo2' ? t('BO2 uses a separate game-settings file per mode and a 0–3 bot difficulty scale.') : game.id === 'mw3' ? t('MW3 match rules live in .dsr files; editing the base server config will not change them.') : game.id === 'bo1' ? t('BO1 uses native bot_difficulty alongside the T5 Bot Warfare mod.') : game.id === 'cod4' ? t('Your CoD4 install uses a customized Bot Warfare fork. Check mod-specific behavior before enabling unfamiliar settings.') : t('Some Bot Warfare controls depend on other settings; custom-team and custom-skill fields appear when selected.')}</p></div><button className="config-source" onClick={() => window.manager.openDocs(game.id).catch(error => setNotice({ text: messageOf(error), error: true }))}><CircleHelp size={15} /> {t('Bot Warfare documentation')} <ExternalLink size={13} /></button></aside>
    {pending && <dialog ref={dialogRef} className="review-dialog" aria-labelledby="review-title" aria-describedby="review-description" onCancel={event => { event.preventDefault(); cancelReview(); }}>
      <div className="review-title"><div><span className="section-kicker">{t('REVIEW BEFORE SAVING')}</span><h2 id="review-title">{t('Confirm configuration')}</h2></div><button aria-label={t('Close review')} disabled={busy} onClick={cancelReview}><X size={19} /></button></div>
      <p id="review-description">{t('Only these settings will change. A byte-for-byte backup is created next to the file.')}</p>
      <div className="config-dialog-activity" role="status" aria-live="polite" aria-atomic="true">{activityMessage}</div>
      <div className="review-list" aria-busy={operation === 'save'}>{pending.preview.changes.map(change => <div className="review-row" key={change.key}><div><strong>{translateOptional(`schema.field.${change.key}`) || change.label}</strong><small>{change.key}{change.duplicates > 1 ? t(' · {count} assignments (last one updated)', { count: change.duplicates }) : ''}</small></div><div><span title={change.before}><span className="sr-only">{t('Before:')} </span>{change.before}</span><ArrowRight size={14} aria-hidden="true" /><b title={change.after}><span className="sr-only">{t('After:')} </span>{change.after}</b></div></div>)}</div>
      <div className="review-actions" aria-busy={busy}><button className="outline-button" disabled={busy} onClick={cancelReview}>{t('Cancel')}</button><button className="button primary-button" disabled={busy || !game.installed} onClick={commit}><Check size={16} /> {tp('Save {count} change', 'Save {count} changes', pending.preview.changes.length)}</button></div>
    </dialog>}
    {activeRestore && <dialog ref={dialogRef} className="review-dialog" aria-labelledby="restore-title" aria-describedby="restore-description" onCancel={event => { event.preventDefault(); cancelReview(); }}>
      <div className="review-title"><div><span className="section-kicker">{t('PREVIEW BACKUP RESTORE')}</span><h2 id="restore-title">{activeRestore.missing ? t('Recreate missing configuration?') : t('Restore configuration?')}</h2></div><button aria-label={t('Close restore preview')} disabled={busy} onClick={cancelReview}><X size={19} /></button></div>
      <p id="restore-description">{activeRestore.missing
        ? target === 'base' ? t('The missing server config will be recreated from the selected backup. There is no current file to back up. Takes effect the next time the server starts.') : t('The missing {mode} mode file will be recreated from the selected backup. There is no current file to back up. Takes effect the next time the server starts.', { mode })
        : target === 'base' ? t('The current server config will be replaced with the selected backup. A copy of the current file is kept. Takes effect the next time the server starts.') : t('The current {mode} mode file will be replaced with the selected backup. A copy of the current file is kept. Takes effect the next time the server starts.', { mode })}</p>
      <div className="config-dialog-activity" role="status" aria-live="polite" aria-atomic="true">{activityMessage}</div>
      <div className="config-restore-summary" aria-busy={operation === 'restore'}><strong>{backupDate(activeRestore.date)}</strong><span>{t('ID')} <code>{activeRestore.id}</code></span><div className="config-restore-sizes"><span>{activeRestore.missing ? t('Current file: missing') : tp('Current: {size} byte', 'Current: {size} bytes', activeRestore.currentBytes, { size: activeRestore.currentBytes.toLocaleString(localeTag()) })}</span><ArrowRight size={14} aria-hidden="true" /><span>{tp('Backup: {size} byte', 'Backup: {size} bytes', activeRestore.backupBytes, { size: activeRestore.backupBytes.toLocaleString(localeTag()) })}</span></div></div>
      <p className="config-restore-warning"><LockKeyhole size={15} /> {t('File contents are hidden because they may contain passwords. Restoring replaces the whole file, including comments and settings outside this editor.')}</p>
      {!!changeCount && <p className="config-restore-warning">{t('Your unsaved edits will be discarded only if the restore succeeds.')}</p>}
      <div className="review-actions" aria-busy={busy}><button className="outline-button" disabled={busy} onClick={cancelReview}>{t('Cancel')}</button><button className="button primary-button" disabled={busy || !game.installed} onClick={restoreBackup}><History size={16} /> {activeRestore.missing ? t('Recreate from backup') : t('Restore backup')}</button></div>
    </dialog>}
  </div>;
}
