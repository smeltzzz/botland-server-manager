import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronDown, CircleHelp, ExternalLink, FileText, Info, LockKeyhole, Save, Search, ShieldCheck, SlidersHorizontal, TriangleAlert, X } from 'lucide-react';
import type { ConfigDocument, ConfigField, ConfigPreview, ConfigTarget, Game, MapData } from './types';
import './config.css';

const sectionOrder = ['Server & access', 'Bot population', 'Teams & balance', 'Difficulty', 'Loadouts', 'Bot behavior', 'Host & diagnostics', 'Match rules'];
function messageOf(error: unknown) { return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
function titleForTarget(game: Game, target: ConfigTarget) {
  if (target === 'base') return 'Server & bot configuration';
  return game.id === 'mw3' ? 'MW3 DSR match rules' : 'BO2 game settings';
}

export default function ConfigWorkspace({ game, maps, refreshRevision, onDirtyChange, onBusyChange }: { game: Game; maps?: MapData | undefined; refreshRevision: number; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void }) {
  const [target, setTarget] = useState<ConfigTarget>('base');
  const [mode, setMode] = useState(game.options.mode);
  const [view, setView] = useState<'guided' | 'advanced'>('guided');
  const [document, setDocument] = useState<ConfigDocument | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const requestId = useRef(0);
  // State updates are asynchronous; a ref blocks a second click in the same tick.
  const working = useRef(false);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, setPending] = useState<{ values: Record<string, string>; preview: ConfigPreview; path: string } | null>(null);
  const supportsModeFile = game.id === 'mw3' || game.id === 'bo2';
  useEffect(() => { setTarget('base'); setMode(game.options.mode); setSearch(''); }, [game.id]);
  useEffect(() => {
    let active = true;
    requestId.current++;
    setLoading(true); setDocument(null); setPending(null); setNotice(null);
    window.manager.document(game.id, target, mode).then(result => {
      if (!active) return;
      setDocument(result); setDraft(result.values);
    }).catch(error => { if (active) setNotice({ text: messageOf(error), error: true }); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; requestId.current++; };
  }, [game.id, game.gamePath, game.configPath, target, mode, refreshRevision]);
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
  useEffect(() => { onDirtyChange(changeCount > 0); }, [changeCount, onDirtyChange]);
  useEffect(() => { onBusyChange(busy || !!pending); }, [busy, pending, onBusyChange]);
  useEffect(() => () => { onDirtyChange(false); onBusyChange(false); }, [onDirtyChange, onBusyChange]);
  // Escape dismisses the review dialog, except while a save is in flight.
  useEffect(() => {
    if (!pending || busy) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setPending(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [pending, busy]);
  function canSwitch() {
    return !busy && !pending && (!changeCount || window.confirm('Discard unsaved configuration changes?'));
  }
  async function review() {
    if (!document || !changeCount || busy || working.current) return;
    working.current = true;
    const request = requestId.current;
    const values = { ...edits };
    const file = document.path;
    setBusy(true); setNotice(null);
    try {
      const preview = await window.manager.previewSettings(game.id, target, mode, values, file);
      if (request !== requestId.current) return;
      if (!preview.changes.length) return setNotice({ text: 'These settings already have the requested values.', error: false });
      setPending({ preview, values, path: file });
    } catch (error) { if (request === requestId.current) setNotice({ text: messageOf(error), error: true }); }
    finally { working.current = false; if (request === requestId.current) setBusy(false); }
  }
  async function commit() {
    if (!pending || busy || working.current) return;
    working.current = true;
    const request = requestId.current;
    setBusy(true);
    try {
      const result = await window.manager.commitSettings(game.id, target, mode, pending.values, pending.preview.token, pending.path);
      if (request !== requestId.current) return;
      setDocument(result); setDraft(result.values); setPending(null);
      setNotice({ text: `Saved ${pending.preview.changes.length} change${pending.preview.changes.length === 1 ? '' : 's'}; the original file was backed up. Restart the server to apply.`, error: false });
    } catch (error) { if (request === requestId.current) { setPending(null); setNotice({ text: messageOf(error), error: true }); } }
    finally { working.current = false; if (request === requestId.current) setBusy(false); }
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
    if (field.type === 'select') return <select value={value} disabled={busy} onChange={event => setValue(event.target.value)}>{!field.choices?.some(item => item.value === value) && <option value={value}>{value || 'Not set'}</option>}{field.choices?.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</select>;
    return <input type={field.type === 'text' ? 'text' : 'number'} step={field.type === 'decimal' ? '0.1' : '1'} min={field.min} max={game.id === 'mw3' && field.key === 'sv_maxclients' ? 18 : field.max} maxLength={field.maxLength} value={value} disabled={busy} onChange={event => setValue(event.target.value)} />;
  }
  return <div className="config-layout">
    <section className="panel config-main">
      <div className="config-title"><div className="panel-icon"><SlidersHorizontal size={19} /></div><div><span className="section-kicker">MAKE IT YOURS</span><h2>{titleForTarget(game, target)}</h2></div></div>
      <p className="panel-description">Game-specific controls built around this title’s settings. Changes are previewed and backed up before they touch your files.</p>
      {supportsModeFile && <div className="config-targets"><button className={target === 'base' ? 'active' : ''} onClick={() => { if (canSwitch()) setTarget('base'); }}>Server & bots</button><button className={target === 'mode' ? 'active' : ''} onClick={() => { if (canSwitch()) setTarget('mode'); }}>Mode rules</button>{target === 'mode' && <label><span>RULESET</span><select value={mode} onChange={event => { if (canSwitch()) setMode(event.target.value); }}>{maps?.modes?.length ? <>{!maps.modes.some(item => item.value === mode) && <option value={mode} disabled>{mode} (not installed)</option>}{maps.modes.map(item => <option value={item.value} key={item.value}>{item.label}</option>)}</> : <option value={mode}>{mode}</option>}</select><ChevronDown size={14} /></label>}</div>}
      <div className="config-toolbar"><div className="config-switch"><button className={view === 'guided' ? 'selected' : ''} onClick={() => { setView('guided'); setSearch(''); }}>Guided settings</button><button className={view === 'advanced' ? 'selected' : ''} onClick={() => { setView('advanced'); setSearch(''); }}>All existing settings <span>{document?.entries.length || 0}</span></button></div><div className="config-search"><Search size={15} /><input type="search" placeholder="Search settings…" value={search} onChange={event => setSearch(event.target.value)} /></div></div>
      {notice && <div className={`config-notice ${notice.error ? 'error' : 'success'}`}>{notice.error ? <TriangleAlert size={16} /> : <Check size={16} />}{notice.text}</div>}
      {loading && <div className="config-empty">Loading settings from the installed game…</div>}
      {!loading && !document && <div className="config-empty"><FileText size={22} /> Config file could not be opened. Check the game folder above.</div>}
      {!loading && document && <>
        {view === 'guided' ? <div className="config-groups">{sectionOrder.map(section => {
          const visible = guided.filter(field => field.section === section);
          if (!visible.length) return null;
          return <div className="config-group" key={section}><div className="config-group-title"><span>{section.toUpperCase()}</span><span>{visible.length.toString().padStart(2, '0')}</span></div><div className="config-field-grid">{visible.map(field => <label className="form-field" key={field.key}><span>{field.label}{!(field.key in document.values) && <em title="The game currently uses its default until you edit this field.">DEFAULT</em>}</span><small>{field.hint || field.sourceKey}</small>{fieldControl(field)}</label>)}</div></div>;
        })}{!guided.length && <div className="config-empty">No guided settings match this search.</div>}</div>
          : <><div className="advanced-tip"><LockKeyhole size={15} /> Sensitive values are never read into the UI. You may replace them, but the game still stores them in its config and backup files.</div><div className="advanced-list">{entries.map(entry => <div className="advanced-row" key={entry.key}><div><strong>{entry.key}</strong>{entry.count > 1 && <span className="duplicate-tag" title="The last active assignment takes effect.">DUPLICATE ×{entry.count}</span>}{entry.masked && <span title="Sensitive value hidden"><LockKeyhole size={14} /></span>}</div><input type={entry.masked ? 'password' : 'text'} aria-label={`Value for ${entry.key}`} title={entry.key === 'bots_manage_add' ? 'One-shot runtime command; editing its saved value is not supported.' : undefined} disabled={busy || entry.key === 'bots_manage_add'} placeholder={entry.masked ? 'Replace hidden value' : ''} value={Object.hasOwn(draft, entry.key) ? draft[entry.key] : (entry.masked ? '' : entry.value)} onChange={event => setDraft(previous => ({ ...previous, [entry.key]: event.target.value }))} /></div>)}{!entries.length && <div className="config-empty">No existing settings match this search.</div>}</div></>}
        <div className="config-savebar"><span><ShieldCheck size={16} /> {changeCount ? `${changeCount} unsaved change${changeCount === 1 ? '' : 's'}` : 'Changes are backed up before saving.'}</span><button className="button primary-button" disabled={!changeCount || busy} onClick={review}><Save size={16} /> Review changes</button></div>
      </>}
    </section>
    <aside className="config-aside"><div className="panel"><div className="panel-icon featured"><FileText size={19} /></div><h3>Know your config.</h3><p>These options are based on the Bot Warfare documentation and settings actually supported by this game. Unrecognized directives and your existing comments are kept.</p><div className="config-file-label">EDITING FILE</div><div className="config-file-path" title={document?.path}>{document?.path || game.configPath}</div><button className="outline-button full-width" onClick={() => window.manager.openDocument(game.id, target, mode).catch(error => setNotice({ text: messageOf(error), error: true }))}><ExternalLink size={15} /> Open original file</button></div><div className="aside-tip"><Info size={17} /><p>{game.id === 'bo2' ? 'BO2 uses a separate game-settings file per mode and a 0–3 bot difficulty scale.' : game.id === 'mw3' ? 'MW3 match rules live in .dsr files; editing the base server config will not change them.' : game.id === 'bo1' ? 'BO1 uses native bot_difficulty alongside the T5 Bot Warfare mod.' : game.id === 'cod4' ? 'Your CoD4 install uses a customized Bot Warfare fork. Check mod-specific behavior before enabling unfamiliar settings.' : 'Some Bot Warfare controls depend on other settings; custom-team and custom-skill fields appear when selected.'}</p></div><button className="config-source" onClick={() => window.manager.openDocs(game.id).catch(error => setNotice({ text: messageOf(error), error: true }))}><CircleHelp size={15} /> Bot Warfare documentation <ExternalLink size={13} /></button></aside>
    {pending && <div className="dialog-backdrop" role="presentation"><div className="review-dialog" role="dialog" aria-modal="true" aria-labelledby="review-title"><div className="review-title"><div><span className="section-kicker">REVIEW BEFORE SAVING</span><h2 id="review-title">Confirm configuration</h2></div><button aria-label="Close review" disabled={busy} onClick={() => setPending(null)}><X size={19} /></button></div><p>Only these settings will change. A byte-for-byte backup is created next to the file.</p><div className="review-list">{pending.preview.changes.map(change => <div className="review-row" key={change.key}><div><strong>{change.label}</strong><small>{change.key}{change.duplicates > 1 ? ` · ${change.duplicates} assignments (last one updated)` : ''}</small></div><div><span>{change.before}</span><ArrowRight size={14} /><b>{change.after}</b></div></div>)}</div><div className="review-actions"><button className="outline-button" disabled={busy} onClick={() => setPending(null)}>Cancel</button><button className="button primary-button" disabled={busy} onClick={commit}><Check size={16} /> Save {pending.preview.changes.length} changes</button></div></div></div>}
  </div>;
}
