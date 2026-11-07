import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronDown, CircleHelp, ExternalLink, FileText, History, Info, LockKeyhole, Save, Search, ShieldCheck, SlidersHorizontal, Trash2, TriangleAlert, X } from 'lucide-react';
import type { ConfigDocument, ConfigField, ConfigPreview, ConfigTarget, Game, MapData } from './types';
import './config.css';

const sectionOrder = ['Server & access', 'Bot population', 'Teams & balance', 'Difficulty', 'Loadouts', 'Bot behavior', 'Host & diagnostics', 'Match rules'];
function messageOf(error: unknown) { return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
function titleForTarget(game: Game, target: ConfigTarget) {
  if (target === 'base') return 'Server & bot configuration';
  return game.id === 'mw3' ? 'MW3 DSR match rules' : 'BO2 game settings';
}
function backupDate(date: string) {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleString();
}
type ConfigBackup = { id: string; date: string; bytes: number };
type RestoreReview = { id: string; date: string; token: string; currentBytes: number; backupBytes: number; context: string };

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
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
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
  useEffect(() => { setTarget('base'); setMode(game.options.mode); setSearch(''); }, [game.id]);
  useEffect(() => {
    let active = true;
    const request = ++requestId.current;
    setPending(null); setRestoreReview(null);
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
  function loadBackups(request = requestId.current) {
    const listRequest = ++backupRequest.current;
    setBackupLoading(true);
    window.manager.listConfigBackups(game.id, target, mode).then(list => {
      if (request !== requestId.current || listRequest !== backupRequest.current || contextKey !== currentContext.current) return;
      setBackups(list); setBackupScope(contextKey); setBackupError(null);
    }).catch(error => {
      if (request === requestId.current && listRequest === backupRequest.current && contextKey === currentContext.current) setBackupError(messageOf(error));
    }).finally(() => {
      if (request === requestId.current && listRequest === backupRequest.current && contextKey === currentContext.current) setBackupLoading(false);
    });
  }
  const guided = useMemo(() => document?.fields.filter(field => !field.presentOnly || field.key in document.values).filter(field => {
    if (!field.dependsOn) return true;
    const current = draft[field.dependsOn.key] ?? document.values[field.dependsOn.key] ?? document.fields.find(other => other.key === field.dependsOn?.key)?.default;
    return current === field.dependsOn.value;
  }).filter(field => `${field.label} ${field.key} ${field.hint || ''}`.toLowerCase().includes(search.toLowerCase())) || [], [document, draft, search]);
  const entries = useMemo(() => document?.entries.filter(entry => entry.key.includes(search.trim().toLowerCase()) || document.fields.find(field => field.key === entry.key)?.label.toLowerCase().includes(search.trim().toLowerCase())) || [], [document, search]);
  const edits = Object.fromEntries(Object.entries(draft).filter(([key, value]) => {
    if (!document) return false;
    const entry = document.entries.find(item => item.key === key);
    if (entry?.masked) return value !== '';
    const original = document.values[key] ?? entry?.value ?? document.fields.find(field => field.key === key)?.default;
    return value !== original;
  }));
  const changeCount = Object.keys(edits).length;
  const visibleBackups = backupScope === contextKey ? backups : [];
  const activeRestore = restoreReview?.context === contextKey ? restoreReview : null;
  useEffect(() => { onDirtyChange(changeCount > 0); }, [changeCount, onDirtyChange]);
  useEffect(() => { onBusyChange(busy || !!pending || !!restoreReview); }, [busy, pending, restoreReview, onBusyChange]);
  useEffect(() => () => { onDirtyChange(false); onBusyChange(false); }, [onDirtyChange, onBusyChange]);
  // Native modal dialogs trap keyboard focus and make the background inert.
  // Return focus to the review/restore trigger when the modal closes.
  const reviewOpen = !!pending || !!activeRestore;
  useEffect(() => {
    if (!reviewOpen) return;
    const dialog = dialogRef.current;
    const trigger = window.document.activeElement;
    if (!dialog) return;
    dialog.showModal();
    dialog.querySelector('button')?.focus();
    return () => {
      dialog.close();
      window.requestAnimationFrame(() => {
        if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
      });
    };
  }, [reviewOpen]);
  function canSwitch() {
    if (busy || pending || restoreReview) return false;
    if (changeCount && !window.confirm('Discard unsaved configuration changes?')) return false;
    if (changeCount) setDraft(document?.values || {});
    return true;
  }
  async function review() {
    if (!document || !changeCount || busy || working.current || pathConflict || loadedPath.current !== pathKey || restoreReview) return;
    working.current = true;
    const request = requestId.current;
    const values = { ...edits };
    const file = document.path;
    setBusy(true); setNotice(null);
    try {
      const preview = await window.manager.previewSettings(game.id, target, mode, values, file);
      if (request !== requestId.current || contextKey !== currentContext.current) return;
      if (!preview.changes.length) return setNotice({ text: 'These settings already have the requested values.', error: false });
      setPending({ preview, values, path: file });
    } catch (error) { if (request === requestId.current && contextKey === currentContext.current) setNotice({ text: messageOf(error), error: true }); }
    finally { working.current = false; setBusy(false); }
  }
  async function commit() {
    if (!pending || busy || working.current || pathConflict || loadedPath.current !== pathKey) return;
    working.current = true;
    const request = requestId.current;
    setBusy(true);
    try {
      const result = await window.manager.commitSettings(game.id, target, mode, pending.values, pending.preview.token, pending.path);
      if (request !== requestId.current || contextKey !== currentContext.current) return;
      setDocument(result); setDraft(result.values); setPending(null);
      loadBackups(request);
      setNotice({ text: `Saved ${pending.preview.changes.length} change${pending.preview.changes.length === 1 ? '' : 's'}; the original file was backed up. Restart the server to apply.`, error: false });
    } catch (error) {
      if (request === requestId.current && contextKey === currentContext.current) {
        const message = messageOf(error);
        setPending(null);
        // The main process reports explicitly when the file was already saved
        // but the follow-up read failed; reload instead of inviting a retry.
        if (/^The configuration was saved, but it could not be reloaded/i.test(message)) setReloadRevision(previous => previous + 1);
        setNotice({ text: message, error: true });
      }
    }
    finally { working.current = false; setBusy(false); }
  }
  async function previewRestore(backup: ConfigBackup) {
    if (busy || pending || restoreReview || working.current || backupScope !== contextKey || !visibleBackups.some(item => item.id === backup.id)) return;
    working.current = true;
    const request = requestId.current;
    setBusy(true); setNotice(null);
    try {
      const preview = await window.manager.previewConfigRestore(game.id, target, mode, backup.id);
      if (request !== requestId.current || contextKey !== currentContext.current) return;
      if (!preview.summary.changed) {
        setNotice({ text: 'The current file already matches this backup.', error: false });
        return;
      }
      // Never put preview.summary.contents in state or in the DOM: backups can contain secrets.
      setRestoreReview({ id: backup.id, date: backup.date, token: preview.token, currentBytes: preview.summary.currentBytes, backupBytes: preview.summary.backupBytes, context: contextKey });
    } catch (error) {
      if (request === requestId.current && contextKey === currentContext.current) setNotice({ text: messageOf(error), error: true });
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function restoreBackup() {
    if (!activeRestore || busy || working.current) return;
    if (changeCount && !window.confirm('Restoring this backup will discard your unsaved configuration edits. Continue?')) return;
    working.current = true;
    const request = requestId.current;
    const { id, token } = activeRestore;
    setBusy(true); setNotice(null);
    try {
      if (contextKey !== currentContext.current) return;
      await window.manager.restoreConfigBackup(game.id, target, mode, id, token);
      if (request !== requestId.current || contextKey !== currentContext.current) return;
      setRestoreReview(null);
      setDocument(null); setDraft({}); setLoading(true); setSelectedBackups([]);
      loadBackups(request);
      try {
        const result = await window.manager.document(game.id, target, mode);
        if (request !== requestId.current || contextKey !== currentContext.current) return;
        setDocument(result); setDraft(result.values);
        setNotice({ text: 'Configuration restored. Restart the server to apply it.', error: false });
      } catch (error) {
        if (request === requestId.current && contextKey === currentContext.current) setNotice({ text: `Backup restored, but settings could not be reloaded: ${messageOf(error)}`, error: true });
      }
    } catch (error) {
      if (request === requestId.current && contextKey === currentContext.current) { setRestoreReview(null); setNotice({ text: messageOf(error), error: true }); }
    } finally {
      working.current = false;
      if (request === requestId.current && contextKey === currentContext.current) setLoading(false);
      setBusy(false);
    }
  }
  async function pruneBackups() {
    if (!selectedBackups.length || busy || pending || restoreReview || working.current || backupScope !== contextKey) return;
    const ids = selectedBackups.filter(id => visibleBackups.some(backup => backup.id === id));
    if (!ids.length || !window.confirm(`Permanently delete ${ids.length} selected configuration backup${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    working.current = true;
    const request = requestId.current;
    setBusy(true); setNotice(null);
    try {
      if (contextKey !== currentContext.current) return;
      const result = await window.manager.pruneConfigBackups(game.id, target, mode, ids);
      if (request !== requestId.current || contextKey !== currentContext.current) return;
      setSelectedBackups([]);
      loadBackups(request);
      setNotice({ text: `Removed ${result.removed} configuration backup${result.removed === 1 ? '' : 's'}.`, error: false });
    } catch (error) {
      if (request === requestId.current && contextKey === currentContext.current) setNotice({ text: messageOf(error), error: true });
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  function fieldControl(field: ConfigField) {
    const value = draft[field.key] ?? (field.default ?? '');
    const setValue = (next: string) => setDraft(previous => {
      const updated = { ...previous, [field.key]: next };
      // Fields this choice hides must not keep pending edits that would still be saved.
      for (const other of document?.fields || []) {
        if (other.dependsOn?.key !== field.key || other.dependsOn.value === next) continue;
        if (document && Object.hasOwn(document.values, other.key)) updated[other.key] = document.values[other.key]!;
        else delete updated[other.key];
      }
      return updated;
    });
    if (field.type === 'select') return <select value={value} disabled={busy || !!restoreReview} onChange={event => setValue(event.target.value)}>{!field.choices?.some(item => item.value === value) && <option value={value}>{value || 'Not set'}</option>}{field.choices?.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</select>;
    // MW2, MW3 and BO2 cap player slots at 18 (the schema and save path enforce
    // the same cap), so the guided input must not offer a higher value.
    const slotCap = ['mw2', 'mw3', 'bo2'].includes(game.id) && field.key === 'sv_maxclients' ? 18 : field.max;
    return <input type={field.type === 'text' ? 'text' : 'number'} step={field.type === 'decimal' ? '0.1' : '1'} min={field.min} max={slotCap} maxLength={field.maxLength} value={value} disabled={busy || !!restoreReview} onChange={event => setValue(event.target.value)} />;
  }
  return <div className="config-layout">
    <section className="panel config-main">
      <div className="config-title"><div className="panel-icon"><SlidersHorizontal size={19} /></div><div><span className="section-kicker">MAKE IT YOURS</span><h2>{titleForTarget(game, target)}</h2></div></div>
      <p className="panel-description">Game-specific controls built around this title’s settings. Changes are previewed and backed up before they touch your files.</p>
      {supportsModeFile && <div className="config-targets"><button className={target === 'base' ? 'active' : ''} aria-pressed={target === 'base'} onClick={() => { if (target !== 'base' && canSwitch()) setTarget('base'); }}>Server & bots</button><button className={target === 'mode' ? 'active' : ''} aria-pressed={target === 'mode'} onClick={() => { if (target !== 'mode' && canSwitch()) setTarget('mode'); }}>Mode rules</button>{target === 'mode' && <label><span>RULESET</span><select value={mode} onChange={event => { if (event.target.value !== mode && canSwitch()) setMode(event.target.value); }}>{maps?.modes?.length ? <>{!maps.modes.some(item => item.value === mode) && <option value={mode} disabled>{mode} (not installed)</option>}{maps.modes.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</> : <option value={mode}>{mode}</option>}</select><ChevronDown size={14} /></label>}</div>}
      <div className="config-toolbar"><div className="config-switch"><button className={view === 'guided' ? 'selected' : ''} aria-pressed={view === 'guided'} onClick={() => { setView('guided'); setSearch(''); }}>Guided settings</button><button className={view === 'advanced' ? 'selected' : ''} aria-pressed={view === 'advanced'} onClick={() => { setView('advanced'); setSearch(''); }}>All existing settings <span>{document?.entries.length || 0}</span></button></div><div className="config-search"><Search size={15} /><input type="search" aria-label="Search configuration settings" placeholder="Search settings…" value={search} onChange={event => setSearch(event.target.value)} /></div></div>
      {pathConflict && <div className="config-path-warning" role="alert"><TriangleAlert size={17} /><div><strong>Game folder changed while you were editing.</strong><p>Your unsaved edits are still shown below for reference. Saving to the old location is blocked. Copy anything you need before loading the new file.</p><button className="outline-button" onClick={() => { setDraft(document?.values || {}); setPathConflict(false); setReloadRevision(previous => previous + 1); }}>Discard edits and load new file</button></div></div>}
      {notice && <div className={`config-notice ${notice.error ? 'error' : 'success'}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <TriangleAlert size={16} /> : <Check size={16} />}{notice.text}</div>}
      {loading && <div className="config-empty">Loading settings from the installed game…</div>}
      {!loading && !document && <div className="config-empty"><FileText size={22} /> Config file could not be opened. Check the game folder above.</div>}
      {!loading && document && <>
        {view === 'guided' ? <div className="config-groups">{sectionOrder.map(section => {
          const visible = guided.filter(field => field.section === section);
          if (!visible.length) return null;
          return <div className="config-group" key={section}><div className="config-group-title"><span>{section.toUpperCase()}</span><span>{visible.length.toString().padStart(2, '0')}</span></div><div className="config-field-grid">{visible.map(field => <label className="form-field" key={field.key}><span>{field.label}{!(field.key in document.values) && <em title="The game currently uses its default until you edit this field.">DEFAULT</em>}</span><small>{field.hint || field.sourceKey}</small>{fieldControl(field)}</label>)}</div></div>;
        })}{!guided.length && <div className="config-empty">No guided settings match this search.</div>}</div>
          : <><div className="advanced-tip"><LockKeyhole size={15} /> Sensitive values are never read into the UI. You may replace them, but the game still stores them in its config and backup files.</div><div className="advanced-list">{entries.map(entry => <div className="advanced-row" key={entry.key}><div><strong>{entry.key}</strong>{entry.count > 1 && <span className="duplicate-tag" title="The last active assignment takes effect.">DUPLICATE ×{entry.count}</span>}{entry.masked && <span title="Sensitive value hidden"><LockKeyhole size={14} /></span>}</div><input type={entry.masked ? 'password' : 'text'} aria-label={`Value for ${entry.key}`} title={entry.key === 'bots_manage_add' ? 'One-shot runtime command; editing its saved value is not supported.' : undefined} disabled={busy || !!restoreReview || entry.key === 'bots_manage_add'} placeholder={entry.masked ? 'Replace hidden value' : ''} value={Object.hasOwn(draft, entry.key) ? draft[entry.key] : (entry.masked ? '' : entry.value)} onChange={event => setDraft(previous => ({ ...previous, [entry.key]: event.target.value }))} /></div>)}{!entries.length && <div className="config-empty">No existing settings match this search.</div>}</div></>}
        <div className="config-savebar"><span><ShieldCheck size={16} /> {changeCount ? `${changeCount} unsaved change${changeCount === 1 ? '' : 's'}` : 'Changes are backed up before saving.'}</span><button className="button primary-button" disabled={!changeCount || busy || !!restoreReview || pathConflict || loadedPath.current !== pathKey} onClick={review}><Save size={16} /> Review changes</button></div>
      </>}
    </section>
    <aside className="config-aside"><div className="panel"><div className="panel-icon featured"><FileText size={19} /></div><h3>Know your config.</h3><p>These options are based on the Bot Warfare documentation and settings actually supported by this game. Unrecognized directives and your existing comments are kept.</p><div className="config-file-label">EDITING FILE</div><div className="config-file-path" title={document?.path}>{document?.path || game.configPath}</div><button className="outline-button full-width" onClick={() => window.manager.openDocument(game.id, target, mode).catch(error => setNotice({ text: messageOf(error), error: true }))}><ExternalLink size={15} /> Open original file</button></div><div className="panel config-backups"><div className="config-backups-heading"><History size={18} /><div><span className="section-kicker">CONFIGURATION FILES</span><h3>Backups</h3></div></div><p>Saved copies of this {target === 'base' ? 'server config' : `${mode} mode file`}. These are separate from Bot Warfare mod versions. Contents may include passwords; previews show file sizes only.</p>{backupLoading && <p className="config-backups-status" role="status">Loading backups…</p>}{backupError && <div className="config-backups-error" role="alert">{backupError} <button className="inline-link" onClick={() => loadBackups()}>Retry</button></div>}{!backupLoading && !backupError && !visibleBackups.length && <p className="config-backups-status">{pathConflict ? 'Load the new file before viewing its backups.' : 'No saved copies for this file yet.'}</p>}{!!visibleBackups.length && <><div className="config-backups-list">{visibleBackups.map(backup => <div className="config-backup" key={backup.id}><label><input type="checkbox" aria-label={`Select backup ${backup.id} for deletion`} checked={selectedBackups.includes(backup.id)} disabled={busy || !!pending || !!restoreReview} onChange={event => setSelectedBackups(previous => event.target.checked ? [...previous, backup.id] : previous.filter(id => id !== backup.id))} /><span><strong>{backupDate(backup.date)}</strong><small>{backup.bytes.toLocaleString()} bytes · ID <code>{backup.id}</code></small></span></label><button className="outline-button" disabled={busy || !!pending || !!restoreReview || backupLoading} onClick={() => previewRestore(backup)}>Preview restore</button></div>)}</div><button className="outline-button full-width config-prune" disabled={!selectedBackups.length || busy || !!pending || !!restoreReview || backupLoading} onClick={pruneBackups}><Trash2 size={14} /> Delete {selectedBackups.length} selected</button></>}</div><div className="aside-tip"><Info size={17} /><p>{game.id === 'bo2' ? 'BO2 uses a separate game-settings file per mode and a 0–3 bot difficulty scale.' : game.id === 'mw3' ? 'MW3 match rules live in .dsr files; editing the base server config will not change them.' : game.id === 'bo1' ? 'BO1 uses native bot_difficulty alongside the T5 Bot Warfare mod.' : game.id === 'cod4' ? 'Your CoD4 install uses a customized Bot Warfare fork. Check mod-specific behavior before enabling unfamiliar settings.' : 'Some Bot Warfare controls depend on other settings; custom-team and custom-skill fields appear when selected.'}</p></div><button className="config-source" onClick={() => window.manager.openDocs(game.id).catch(error => setNotice({ text: messageOf(error), error: true }))}><CircleHelp size={15} /> Bot Warfare documentation <ExternalLink size={13} /></button></aside>
    {pending && <dialog ref={dialogRef} className="review-dialog" aria-labelledby="review-title" onCancel={event => { event.preventDefault(); if (!busy) setPending(null); }}><div className="review-title"><div><span className="section-kicker">REVIEW BEFORE SAVING</span><h2 id="review-title">Confirm configuration</h2></div><button aria-label="Close review" disabled={busy} onClick={() => setPending(null)}><X size={19} /></button></div><p>Only these settings will change. A byte-for-byte backup is created next to the file.</p><div className="review-list">{pending.preview.changes.map(change => <div className="review-row" key={change.key}><div><strong>{change.label}</strong><small>{change.key}{change.duplicates > 1 ? ` · ${change.duplicates} assignments (last one updated)` : ''}</small></div><div><span>{change.before}</span><ArrowRight size={14} /><b>{change.after}</b></div></div>)}</div><div className="review-actions"><button className="outline-button" disabled={busy} onClick={() => setPending(null)}>Cancel</button><button className="button primary-button" disabled={busy} onClick={commit}><Check size={16} /> Save {pending.preview.changes.length} changes</button></div></dialog>}
    {activeRestore && <dialog ref={dialogRef} className="review-dialog" aria-labelledby="restore-title" onCancel={event => { event.preventDefault(); if (!busy) setRestoreReview(null); }}><div className="review-title"><div><span className="section-kicker">PREVIEW BACKUP RESTORE</span><h2 id="restore-title">Restore configuration?</h2></div><button aria-label="Close restore preview" disabled={busy} onClick={() => setRestoreReview(null)}><X size={19} /></button></div><p>The current {target === 'base' ? 'server config' : `${mode} mode file`} will be replaced with the selected backup. A copy of the current file is kept. Restart the server to apply.</p><div className="config-restore-summary"><strong>{backupDate(activeRestore.date)}</strong><span>ID <code>{activeRestore.id}</code></span><span>Current: {activeRestore.currentBytes.toLocaleString()} bytes <ArrowRight size={14} /> Backup: {activeRestore.backupBytes.toLocaleString()} bytes</span></div><p className="config-restore-warning"><LockKeyhole size={15} /> File contents are hidden because they may contain passwords. Restoring replaces the whole file, including comments and settings outside this editor.{changeCount ? ' Your unsaved edits will be discarded only if the restore succeeds.' : ''}</p><div className="review-actions"><button className="outline-button" disabled={busy} onClick={() => setRestoreReview(null)}>Cancel</button><button className="button primary-button" disabled={busy} onClick={restoreBackup}><History size={16} /> Restore backup</button></div></dialog>}
  </div>;
}
