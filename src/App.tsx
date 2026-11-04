import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowLeft, ArrowRight, Check, ChevronRight, Clock3,
  ExternalLink, FolderOpen, Gamepad2, HardDrive, Info, LayoutDashboard,
  ListFilter, Map as MapIcon, Play, Radio, RefreshCw, Save, Search,
  Server, Settings2, ShieldCheck, SlidersHorizontal, Square, Terminal,
  TriangleAlert, X,
} from 'lucide-react';
import type { Game, GameId, LogEntry, MapData, Snapshot, FirewallStatus } from './types';
import ConfigWorkspace from './ConfigWorkspace';
import './artwork.css';

type Tab = 'overview' | 'configuration' | 'rotation' | 'console';
const gameNumbers: Record<GameId, string> = { cod4: '01', waw: '02', mw2: '03', bo1: '04', mw3: '05', bo2: '06' };
const gameCodes: Record<GameId, string> = { cod4: 'IW3', waw: 'T4', mw2: 'IW4', bo1: 'T5', mw3: 'IW5', bo2: 'T6' };
const tabs: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'configuration', label: 'Configuration', icon: SlidersHorizontal },
  { id: 'rotation', label: 'Maps & modes', icon: MapIcon },
  { id: 'console', label: 'Console', icon: Terminal },
];

function statusLabel(game: Game) {
  if (game.status === 'running') return 'Running';
  if (game.status === 'starting') return 'Starting';
  if (game.status === 'stopping') return 'Stopping';
  return game.blockers.length ? 'Needs setup' : 'Ready to launch';
}
function displayError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, '');
}
function gameTime(date: string) { return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function gameMapName(name: string) { return name.replace(/^mp_/, '').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase()); }

function StateChip({ game }: { game: Game }) {
  const state = game.status === 'running' ? 'online' : game.blockers.length ? 'attention' : 'ready';
  return <span className={`state-chip ${state}`}><span className="state-dot" />{statusLabel(game)}</span>;
}
function VisibilitySwitch({ game, disabled, onChange }: { game: Game; disabled: boolean; onChange: (lan: boolean) => void }) {
  if (game.id === 'bo1') return <span className="visibility-locked" title="Black Ops has no LAN flag in its launch profile; it stays public.">PUBLIC ONLY</span>;
  return <span className={`visibility-switch ${game.options.lan ? 'lan' : 'public'}`} role="group" aria-label="Server visibility">
    <button type="button" aria-pressed={game.options.lan} disabled={disabled} title="Only reachable inside your local network" onClick={() => onChange(true)}>LAN</button>
    <button type="button" aria-pressed={!game.options.lan} disabled={disabled} title={`Reachable beyond your local network; outside players also need UDP ${game.options.port} forwarded on your router`} onClick={() => onChange(false)}>Public</button>
  </span>;
}
function FirewallPanel({ game, status, busy, onApply, onRemove }: { game: Game; status: FirewallStatus | null; busy: boolean; onApply: () => void; onRemove: () => void }) {
  if (!status) return <p className="firewall-note">Checking the Windows firewall rule…</p>;
  const titles: Record<string, string> = { missing: 'NO RULE', lan: 'LAN-ONLY INBOUND', any: 'PUBLIC INBOUND', drift: 'MISMATCHED RULE', unknown: 'STATUS UNKNOWN' };
  // BO1 always launches public, so its rule is always scoped to the LAN (mirrors firewallScope).
  const lanRule = game.id === 'bo1' || game.options.lan;
  const matchesVisibility = status.state === (lanRule ? 'lan' : 'any');
  const active = status.state === 'lan' || status.state === 'any';
  // While running, the rule follows the port the server was launched with.
  const pendingPort = game.activePort != null && game.activePort !== game.options.port;
  return <div>
    <div className="firewall-row">
      <span className={`fw-chip ${status.state}`}><ShieldCheck size={14} /> {titles[status.state]}</span>
      {matchesVisibility
        ? (active && <button className="inline-link" disabled={busy} onClick={onRemove}>Remove rule <ArrowRight size={13} /></button>)
        : <button className="button outline-button firewall-apply" disabled={busy} title="Windows asks for administrator approval" onClick={onApply}>{status.state === 'missing' ? 'Create firewall rule' : status.state === 'unknown' ? 'Apply firewall rule' : 'Update firewall rule'}</button>}
    </div>
    {status.state === 'unknown' && <p className="firewall-note">The current rule could not be read. Use refresh to check again, or apply the rule to replace it.</p>}
    <p className="firewall-hint">{lanRule ? 'LAN only' : 'Public'} inbound UDP {status.port} ({lanRule ? 'local subnet' : 'any address'}). Applies immediately, even mid-match. Windows asks for administrator approval. {pendingPort ? <>This rule covers the running server&rsquo;s port; update it after the restart to move it to UDP {game.options.port}. </> : null}{game.id === 'bo1' ? <>Black Ops always launches public, so this rule is what keeps it LAN-only. </> : null}{lanRule ? <>LAN players connect to your PC&rsquo;s local IP and need no router changes.</> : <>Players beyond your home network also need UDP {status.port} opened or forwarded in your router settings — the firewall rule only covers this PC.</>}</p>
  </div>;
}
function Logo() { return <div className="brand-symbol"><span /><span /><span /></div>; }

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selectedId, setSelectedId] = useState<GameId | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [mapCache, setMapCache] = useState<Partial<Record<GameId, MapData & { gamePath: string }>>>({});
  const [covers, setCovers] = useState<Partial<Record<GameId, string | null>>>({});
  const [heroes, setHeroes] = useState<Partial<Record<GameId, string | null>>>({});
  const [mapLoading, setMapLoading] = useState(false);
  const [mapSearch, setMapSearch] = useState('');
  const [mapSelection, setMapSelection] = useState<string[]>([]);
  const [portDraft, setPortDraft] = useState('');
  const [modeDraft, setModeDraft] = useState('');
  const [shuffleDraft, setShuffleDraft] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<GameId | null>(null);
  const [configDirty, setConfigDirty] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [firewallStatus, setFirewallStatus] = useState<FirewallStatus | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  // `busy` state updates asynchronously; this ref blocks a second click in the same tick.
  const busyLock = useRef(false);
  const consoleLines = useRef<HTMLDivElement | null>(null);
  const followConsole = useRef(true);
  const snapshotVersion = useRef(0);
  const snapshotRequest = useRef(0);
  const coverVersions = useRef<Partial<Record<GameId, number>>>({});
  const heroVersions = useRef<Partial<Record<GameId, number>>>({});

  useEffect(() => {
    let active = true;
    const version = snapshotVersion.current;
    const request = ++snapshotRequest.current;
    window.manager.snapshot().then(data => { if (active && version === snapshotVersion.current && request === snapshotRequest.current) setSnapshot(data); }).catch(error => { if (active && version === snapshotVersion.current && request === snapshotRequest.current) setNotice({ text: displayError(error), error: true }); });
    const unsubscribe = window.manager.subscribe(event => {
      if (!active) return;
      // Only full state events supersede an in-flight snapshot request; a log
      // line must not cause a fresh snapshot (which already has logs) to be dropped.
      if (event.type === 'state') { snapshotVersion.current++; setSnapshot(event.snapshot); }
      else if (event.type === 'log') setSnapshot(previous => previous ? {
        ...previous, games: previous.games.map(game => game.id === event.id ? { ...game, logs: [...game.logs, event.entry].slice(-120) } : game),
      } : previous);
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    let active = true;
    const versions = { ...coverVersions.current };
    Promise.all(snapshot.games.map(async game => [game.id, await window.manager.artwork(game.id, 'cover')] as const)).then(images => {
      if (active) setCovers(previous => ({ ...previous, ...Object.fromEntries(images.filter(([id]) => versions[id] === coverVersions.current[id])) }));
    }).catch(() => {});
    return () => { active = false; };
  }, [snapshot?.root]);
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    const version = heroVersions.current[selectedId];
    window.manager.artwork(selectedId, 'hero').then(image => { if (active && version === heroVersions.current[selectedId]) setHeroes(previous => ({ ...previous, [selectedId]: image })); }).catch(() => {});
    return () => { active = false; };
  }, [selectedId]);
  const game = snapshot?.games.find(entry => entry.id === selectedId);
  const maps = selectedId && game && mapCache[selectedId]?.gamePath === game.gamePath ? mapCache[selectedId] : undefined;
  useEffect(() => {
    if (!game) return;
    setPortDraft(String(game.options.port));
    setModeDraft(game.options.mode);
    setShuffleDraft(game.options.shuffle);
  }, [selectedId, game?.options.port, game?.options.mode, game?.options.shuffle]);
  useEffect(() => {
    // A scan abandoned by switching games never reaches its own `finally`, so clear the flag here.
    if (!selectedId || !game?.gamePath) { setMapLoading(false); return; }
    let active = true;
    setMapLoading(true);
    window.manager.maps(selectedId).then(data => {
      if (!active) return;
      setMapCache(previous => ({ ...previous, [selectedId]: { ...data, gamePath: game.gamePath } }));
      setMapSelection(game.options.selectedMaps.length ? game.options.selectedMaps.filter(map => data.maps.includes(map)) : data.maps);
      setModeDraft(data.modes.some(option => option.value === game.options.mode) ? game.options.mode : (data.modes[0]?.value || ''));
    }).catch(error => { if (active) setNotice({ text: displayError(error), error: true }); })
      .finally(() => { if (active) setMapLoading(false); });
    return () => { active = false; };
  }, [selectedId, game?.gamePath, refreshRevision]);

  useEffect(() => {
    if (!selectedId) { setFirewallStatus(null); return; }
    let active = true;
    setFirewallStatus(null);
    window.manager.firewallStatus(selectedId)
      .then(status => { if (active) setFirewallStatus(status); })
      .catch(() => { if (active) setFirewallStatus({ name: '', port: game?.activePort ?? game?.options.port ?? 0, state: 'unknown' }); });
    return () => { active = false; };
  }, [selectedId, game?.options.port, game?.activePort, refreshRevision]);

  // Keep the console on the newest output unless the user has scrolled up to read.
  const lastLog = game?.logs[game.logs.length - 1];
  useEffect(() => { followConsole.current = true; }, [selectedId, tab]);
  useEffect(() => {
    const element = consoleLines.current;
    if (tab === 'console' && element && followConsole.current) element.scrollTop = element.scrollHeight;
  }, [tab, selectedId, game?.logs.length, lastLog?.at, lastLog?.message]);

  const running = snapshot?.games.filter(entry => entry.status === 'running').length || 0;
  const ready = snapshot?.games.filter(entry => !entry.blockers.length).length || 0;
  const visibleMaps = useMemo(() => maps?.maps.filter(map => map.includes(mapSearch.trim().toLowerCase()) || gameMapName(map).toLowerCase().includes(mapSearch.trim().toLowerCase())) || [], [maps, mapSearch]);
  const savedMaps = game && maps ? (game.options.selectedMaps.length ? game.options.selectedMaps.filter(name => maps.maps.includes(name)) : maps.maps) : [];
  const missingMaps = game && maps ? game.options.selectedMaps.filter(name => !maps.maps.includes(name)) : [];
  const missingMode = !!game && !!maps && !maps.modes.some(option => option.value === game.options.mode);
  const savedMode = game ? (missingMode ? maps?.modes[0]?.value || game.options.mode : game.options.mode) : '';
  const rotationDirty = !!game && !!maps && !mapLoading && (portDraft !== String(game.options.port) || modeDraft !== savedMode || shuffleDraft !== game.options.shuffle || mapSelection.length !== savedMaps.length || mapSelection.some(name => !savedMaps.includes(name)));
  function resetRotationDrafts() {
    if (!game) return;
    setPortDraft(String(game.options.port));
    setModeDraft(savedMode);
    setShuffleDraft(game.options.shuffle);
    setMapSelection(savedMaps);
  }
  function canLeave() {
    if (tab === 'configuration' && configBusy) { setNotice({ text: 'Finish or close the configuration review before leaving.', error: true }); return false; }
    if ((tab === 'configuration' && configDirty) || (tab === 'rotation' && rotationDirty)) {
      if (!window.confirm('Discard unsaved changes?')) return false;
      if (tab === 'rotation') resetRotationDrafts();
    }
    return true;
  }
  function selectTab(next: Tab) { if (next !== tab && canLeave()) setTab(next); }
  function goHome() { if (canLeave()) { setSelectedId(null); setTab('overview'); } }
  function refreshWorkspace() {
    if (busy || !canLeave()) return;
    setRefreshRevision(previous => previous + 1);
    action('refresh', () => window.manager.snapshot());
  }
  async function syncSnapshot() {
    const version = snapshotVersion.current;
    const request = ++snapshotRequest.current;
    const data = await window.manager.snapshot();
    if (version === snapshotVersion.current && request === snapshotRequest.current) setSnapshot(data);
  }
  async function action(label: string, task: () => Promise<unknown>, success?: string) {
    if (busy || busyLock.current) return;
    busyLock.current = true;
    setBusy(label); setNotice(null);
    try {
      await task();
      if (success) setNotice({ text: success, error: false });
      await syncSnapshot();
    } catch (error) {
      const text = displayError(error);
      setNotice({ text: label.startsWith('start-') && /Launch cancelled/i.test(text) ? 'Server launch cancelled.' : text, error: !(label.startsWith('start-') && /Launch cancelled/i.test(text)) });
    } finally { busyLock.current = false; setBusy(null); }
  }
  function openGame(id: GameId) { if (!canLeave()) return; setSelectedId(id); setTab('overview'); setMapSearch(''); setNotice(null); }
  async function changeArtwork(id: GameId, kind: 'hero' | 'cover') {
    if (busy || busyLock.current) return;
    busyLock.current = true;
    setBusy('artwork'); setNotice(null);
    try {
      if (await window.manager.chooseArtwork(id, kind)) {
        const image = await window.manager.artwork(id, kind);
        if (kind === 'hero') { heroVersions.current[id] = (heroVersions.current[id] || 0) + 1; setHeroes(previous => ({ ...previous, [id]: image })); }
        else { coverVersions.current[id] = (coverVersions.current[id] || 0) + 1; setCovers(previous => ({ ...previous, [id]: image })); }
        setNotice({ text: `Custom ${kind === 'hero' ? 'header' : 'cover'} artwork selected. The image stays on this computer.`, error: false });
      }
    } catch (error) { setNotice({ text: displayError(error), error: true }); }
    finally { busyLock.current = false; setBusy(null); }
  }
  async function restoreArtwork(id: GameId) {
    if (busy || busyLock.current) return;
    busyLock.current = true;
    setBusy('artwork'); setNotice(null);
    try {
      const [hero, cover] = await Promise.all([window.manager.resetArtwork(id, 'hero'), window.manager.resetArtwork(id, 'cover')]);
      heroVersions.current[id] = (heroVersions.current[id] || 0) + 1;
      coverVersions.current[id] = (coverVersions.current[id] || 0) + 1;
      setHeroes(previous => ({ ...previous, [id]: hero }));
      setCovers(previous => ({ ...previous, [id]: cover }));
      setNotice({ text: 'Using locally cached Steam artwork where available.', error: false });
    } catch (error) { setNotice({ text: displayError(error), error: true }); }
    finally { busyLock.current = false; setBusy(null); }
  }
  function saveRotation() {
    if (!game) return;
    if (mapSelection.length < (game.id === 'bo2' ? 2 : 1)) return setNotice({ text: game.id === 'bo2' ? 'Black Ops II needs at least two maps.' : 'Choose at least one map for the rotation.', error: true });
    const orderedSelection = maps?.maps.filter(map => mapSelection.includes(map)) || mapSelection;
    // An empty list means "every installed map", so maps installed later join the rotation too.
    const everyMap = !!maps && maps.maps.length > 0 && maps.maps.every(map => mapSelection.includes(map));
    action('rotation', () => window.manager.saveOptions(game.id, { port: Number(portDraft), mode: modeDraft, shuffle: shuffleDraft, selectedMaps: everyMap ? [] : orderedSelection }), 'Launch options saved. Rotation will be generated on the next start.');
  }
  function toggleMap(name: string) { setMapSelection(previous => previous.includes(name) ? previous.filter(map => map !== name) : [...previous, name]); }
  function changeVisibility(target: Game, next: boolean) {
    if (target.options.lan === next) return;
    const live = target.status === 'running' || target.status === 'starting';
    const router = next ? '' : ` Players joining from outside your network also need UDP ${target.options.port} opened on your router.`;
    action('visibility', () => window.manager.saveOptions(target.id, { lan: next }),
      `${next ? 'LAN' : 'Public'} visibility saved. ${live ? 'The running server keeps its current visibility until restarted.' : 'Takes effect at the next start.'}${router}`);
  }
  async function changeFirewall(target: Game, apply: boolean) {
    await action(apply ? 'fw-apply' : 'fw-remove', async () => {
      const status = apply ? await window.manager.firewallApply(target.id) : await window.manager.firewallRemove(target.id);
      setFirewallStatus(status);
    }, apply ? `Firewall rule updated for UDP ${target.activePort ?? target.options.port}.` : 'The botLANd firewall rule was removed.');
  }
  async function cancelStart(id: GameId) {
    if (cancelling) return;
    setCancelling(id);
    try { await window.manager.stop(id); await syncSnapshot(); }
    catch (error) { setNotice({ text: displayError(error), error: true }); }
    finally { setCancelling(null); }
  }
  function launchControl(target: Game) {
    return target.status === 'running' || target.status === 'starting'
      ? <button className="button stop-button" disabled={!!cancelling || (!!busy && busy !== `start-${target.id}`)} onClick={event => { event.stopPropagation(); if (target.status === 'starting') cancelStart(target.id); else action(`stop-${target.id}`, () => window.manager.stop(target.id)); }}><Square size={15} fill="currentColor" /> {target.status === 'starting' ? 'Cancel start' : 'Stop server'}</button>
      : <button className="button primary-button" disabled={!!busy || !!target.blockers.length || target.status !== 'stopped'} onClick={event => { event.stopPropagation(); action(`start-${target.id}`, () => window.manager.start(target.id)); }}><Play size={16} fill="currentColor" /> Start server</button>;
  }

  if (!snapshot) return <div className="loading-screen"><Logo /><span>PREPARING YOUR LOBBIES</span>{notice?.error ? <><p role="alert">{notice.text}</p><button className="button primary-button" onClick={() => { setNotice(null); syncSnapshot().catch(error => setNotice({ text: displayError(error), error: true })); }}>Retry status check</button></> : <div className="loading-line" />}</div>;
  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={goHome}><Logo /><div><strong>bot<span className="brand-word-accent">LAN</span>d</strong><small>SERVER MANAGER</small></div></button>
      <div className="nav-heading">WORKSPACE</div>
      <button className={`nav-item ${selectedId === null ? 'active' : ''}`} onClick={goHome}><LayoutDashboard size={18} /> Dashboard <ChevronRight size={15} className="nav-chevron" /></button>
      <div className="nav-heading game-heading">YOUR GAMES <span>{snapshot.games.length.toString().padStart(2, '0')}</span></div>
      <div className="game-nav">{snapshot.games.map(entry => <button key={entry.id} className={`nav-item game-nav-item ${selectedId === entry.id ? 'active' : ''}`} onClick={() => openGame(entry.id)}><span className={`nav-game-glyph ${entry.family}`}>{gameCodes[entry.id].slice(0, 1)}</span><span className="nav-game-label">{entry.short}<small>{entry.engine}</small></span><span className={`nav-status ${entry.status === 'running' ? 'online' : entry.blockers.length ? 'attention' : ''}`} /></button>)}</div>
      <div className="sidebar-footer"><div className="footer-separator" /><div className="root-label"><HardDrive size={15} /> SCRIPTS LOCATION</div><div className="root-path" title={snapshot.root}>{snapshot.root}</div><button className="root-button" disabled={!!busy} onClick={() => { if (canLeave()) action('root', () => window.manager.chooseRoot()); }}><FolderOpen size={15} /> Change folder <ArrowRight size={14} /></button><div className="sidebar-version">botLANd <span>LOCAL / {__APP_VERSION__}</span></div></div>
    </aside>
    <main className="main-pane">
      <header className="topbar"><div className="breadcrumbs"><span>WORKSPACE</span><ChevronRight size={14} /><strong>{game ? game.short.toUpperCase() : 'DASHBOARD'}</strong></div><div className="topbar-right"><span className="local-label"><span className="local-pulse" /> LOCAL MACHINE</span><button className="icon-button" title="Refresh server status" onClick={refreshWorkspace}><RefreshCw size={17} /></button></div></header>
      <div className="page-content">
        {notice && <div className={`notice ${notice.error ? 'notice-error' : 'notice-success'}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <TriangleAlert size={17} /> : <Check size={17} />}<span>{notice.text}</span><button onClick={() => setNotice(null)} aria-label="Dismiss"><X size={16} /></button></div>}
        {!game ? <>
          <section className="dashboard-intro"><div><div className="eyebrow"><span className="eyebrow-line" /> YOUR COMMAND CENTER</div><h1>Make the lobby <em>yours.</em></h1><p>Six games. One place to configure your servers, build your rotations, and get straight into the action.</p></div><div className="intro-mark" aria-hidden="true"><span>BL<span>.</span></span></div></section>
          <div className="stats-row"><div className="stat-card"><div className="stat-icon"><Server size={21} /></div><div><span>YOUR SERVERS</span><strong>06 <small>/ CONFIGURED</small></strong></div></div><div className="stat-card"><div className="stat-icon green"><Activity size={21} /></div><div><span>RUNNING NOW</span><strong>{String(running).padStart(2, '0')} <small>/ LIVE SESSIONS</small></strong></div></div><div className="stat-card"><div className="stat-icon orange"><ShieldCheck size={21} /></div><div><span>READY TO PLAY</span><strong>{String(ready).padStart(2, '0')} <small>/ 06 SERVERS</small></strong></div></div></div>
          <div className="section-heading"><div><span className="section-kicker">YOUR COLLECTION</span><h2>Game servers <span className="heading-count">06</span></h2></div><span className="section-sub">SELECT A GAME TO MANAGE ITS SERVER <ArrowRight size={15} /></span></div>
          <div className="server-grid">{snapshot.games.map(entry => <div key={entry.id} className={`server-card accent-${entry.family}`} onClick={() => openGame(entry.id)}><div className={`card-art ${covers[entry.id] ? 'has-image' : ''}`} style={covers[entry.id] ? { backgroundImage: `url("${covers[entry.id]}")` } : undefined}><div className="card-grid-pattern" /><div className="card-ring ring-a" /><div className="card-ring ring-b" /><span className="card-art-number">{gameNumbers[entry.id]}</span><span className="card-art-code">{gameCodes[entry.id]}</span></div><div className="server-card-body"><div className="card-topline"><span>{entry.engine.toUpperCase()}</span><span className={`card-visibility ${entry.options.lan ? '' : 'public'}`}>{entry.options.lan ? 'LAN' : 'PUBLIC'}</span><StateChip game={entry} /></div><h3>{entry.title}</h3><p>{entry.subtitle} <span className="dot-separator">·</span> UDP {entry.activePort ?? entry.options.port}{entry.activePort != null && entry.activePort !== entry.options.port ? ` (next: ${entry.options.port})` : ''}</p><div className="card-actions">{launchControl(entry)}<button className="card-open" onClick={event => { event.stopPropagation(); openGame(entry.id); }}>MANAGE <ArrowRight size={16} /></button></div></div></div>)}</div>
          <div className="dashboard-note"><Info size={17} /><span>Every game ships with its own unique UDP port. The app checks for conflicts before starting a server. Players joining from outside your home network additionally need that port opened or forwarded in your router settings.</span></div>
        </> : <>
          <div className="detail-back"><button onClick={goHome}><ArrowLeft size={16} /> ALL SERVERS</button><span>/</span><span>{game.short.toUpperCase()}</span></div>
          <section className={`detail-hero accent-${game.family} ${heroes[game.id] ? 'has-image' : ''}`} style={heroes[game.id] ? { backgroundImage: `linear-gradient(90deg,rgba(24,25,23,.95) 0%,rgba(24,25,23,.83) 47%,rgba(24,25,23,.43) 100%),url("${heroes[game.id]}")` } : undefined}><div className="detail-hero-art" aria-hidden="true"><div className="hero-arc" /><span>{gameCodes[game.id]}</span></div><div className="detail-hero-content"><div className="eyebrow"><span className="eyebrow-line" /> {game.engine.toUpperCase()} <span className="eyebrow-divider">/</span> DEDICATED SERVER</div><h1>{game.title}</h1><p>{game.subtitle} <span>·</span> {game.options.lan ? 'LAN' : 'PUBLIC'} BOT SERVER</p><div className="detail-hero-bottom"><StateChip game={game} /><span className="hero-port"><Radio size={15} /> UDP {game.activePort ?? game.options.port}{game.activePort != null && game.activePort !== game.options.port ? ` (next: ${game.options.port})` : ''}</span><span className="hero-port"><Gamepad2 size={15} /> {game.engine}</span><VisibilitySwitch game={game} disabled={!!busy} onChange={next => changeVisibility(game, next)} /></div></div><div className="detail-hero-action">{launchControl(game)}</div></section>
          <nav className="detail-tabs" aria-label="Game sections">{tabs.map(item => <button key={item.id} className={tab === item.id ? 'selected' : ''} onClick={() => selectTab(item.id)}><item.icon size={17} />{item.label}</button>)}</nav>
          {tab === 'overview' && <div className="detail-layout"><div className="detail-primary"><section className="panel"><div className="panel-heading"><div className="panel-icon"><ShieldCheck size={19} /></div><div><span className="section-kicker">PREFLIGHT CHECK</span><h2>Server readiness</h2></div><span className={`readiness-pill ${game.blockers.length ? 'bad' : 'good'}`}>{game.blockers.length ? `${game.blockers.length} ISSUE${game.blockers.length === 1 ? '' : 'S'}` : 'ALL CHECKS PASSED'}</span></div>{!game.blockers.length && !game.warnings.length ? <div className="all-clear"><div><Check size={20} /></div><div><strong>Everything looks good.</strong><span>Your files and launch dependencies are in place. Ready when you are.</span></div></div> : <div className="check-list">{game.blockers.map((issue, index) => <div className="check-item error" key={`b-${index}`}><TriangleAlert size={17} /><span>{issue}</span></div>)}{game.warnings.map((issue, index) => <div className="check-item warning" key={`w-${index}`}><Info size={17} /><span>{issue}</span></div>)}{!game.blockers.length && <div className="check-item success"><Check size={17} /><span>Launch dependencies and config found.</span></div>}</div>}</section>
          <section className="panel"><div className="panel-heading"><div className="panel-icon"><SlidersHorizontal size={19} /></div><div><span className="section-kicker">AT A GLANCE</span><h2>Current setup</h2></div><button className="text-action" onClick={() => selectTab('configuration')}>EDIT SETTINGS <ArrowRight size={15} /></button></div><div className="quick-grid"><div><span>PLAYER SLOTS</span><strong>{game.config.sv_maxclients || '—'}</strong></div><div><span>BOT FILL TARGET</span><strong>{game.config.bots_manage_fill || '—'}</strong></div><div><span>MAPS SELECTED</span><strong>{maps ? (game.options.selectedMaps.length || maps.maps.length) : '—'}</strong></div><div><span>GAME MODE</span><strong>{maps?.modes.find(mode => mode.value === game.options.mode)?.label || game.options.mode.toUpperCase()}</strong></div></div></section></div>
          <div className="detail-secondary"><section className="panel path-panel"><div className="section-kicker">INSTALLATION</div><h3>Game folder</h3><div className="path-display" title={game.gamePath}><FolderOpen size={18} /><span>{game.gamePath || 'Not set'}</span></div><button className="outline-button full-width" disabled={!!busy} onClick={() => action('folder', () => window.manager.chooseFolder(game.id))}><FolderOpen size={16} /> Change game folder</button><div className="panel-divider" /><div className="section-kicker">CONFIG FILE</div><div className="path-display smaller" title={game.configPath}><Settings2 size={17} /><span>{game.configPath || 'Not found'}</span></div><button className="inline-link" disabled={!!busy} onClick={() => action('open', () => window.manager.openConfig(game.id))}>Open original config <ExternalLink size={14} /></button><div className="panel-divider" /><div className="section-kicker">WINDOWS FIREWALL</div><FirewallPanel game={game} status={firewallStatus} busy={!!busy} onApply={() => changeFirewall(game, true)} onRemove={() => changeFirewall(game, false)} /><div className="panel-divider" /><div className="section-kicker">GAME ARTWORK</div><p className="artwork-note">Loaded from your local Steam cache. Custom images are never included in the installer.</p><div className="artwork-actions"><button onClick={() => changeArtwork(game.id, 'cover')} disabled={!!busy}>Change cover</button><button onClick={() => changeArtwork(game.id, 'hero')} disabled={!!busy}>Change header</button><button onClick={() => restoreArtwork(game.id)} disabled={!!busy}>Use Steam art</button></div></section><section className="panel activity-panel"><div className="panel-heading compact"><div><span className="section-kicker">RECENT ACTIVITY</span><h3>Server output</h3></div><button className="text-action" onClick={() => selectTab('console')}>VIEW ALL <ArrowRight size={15} /></button></div>{game.logs.length ? game.logs.slice(-3).reverse().map((line, index) => <div className="activity-line" key={index}><span className={line.level === 'error' ? 'activity-error' : ''} /><p>{line.message}</p><time>{gameTime(line.at)}</time></div>) : <div className="activity-empty"><Clock3 size={19} /> No activity yet. Start the server to see its output.</div>}</section></div></div>}
          {tab === 'configuration' && <ConfigWorkspace key={game.id} game={game} maps={maps} refreshRevision={refreshRevision} onDirtyChange={setConfigDirty} onBusyChange={setConfigBusy} />}
          {tab === 'rotation' && <div className="settings-layout"><div className="panel rotation-panel"><div className="panel-heading"><div className="panel-icon"><MapIcon size={19} /></div><div><span className="section-kicker">THE NEXT MATCH</span><h2>Maps & modes</h2></div></div><p className="panel-description">Only maps found in this installation are listed. A fresh rotation is written when the server starts.</p>{(missingMaps.length > 0 || missingMode) && <div className="config-notice error" role="alert"><TriangleAlert size={16} /> {missingMaps.length > 0 ? `${missingMaps.length} saved map${missingMaps.length === 1 ? '' : 's'} no longer installed. ` : ''}{missingMode ? 'The saved game mode is unavailable. ' : ''}Save updated launch options before starting.</div>}<div className="rotation-controls"><label className="form-field"><span>Game mode</span><small>Available modes for this game</small><select value={modeDraft} disabled={mapLoading || !maps} onChange={event => setModeDraft(event.target.value)}>{maps?.modes?.length ? maps.modes.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>) : <option value={modeDraft}>{modeDraft}</option>}</select></label><label className="form-field"><span>UDP port</span><small>Use a unique port for simultaneous servers</small><input type="number" min="1024" max="65535" value={portDraft} disabled={mapLoading || !maps} onChange={event => setPortDraft(event.target.value)} /></label></div><label className="toggle-row"><span className={`toggle ${shuffleDraft ? 'on' : ''}`}><input type="checkbox" checked={shuffleDraft} disabled={mapLoading || !maps} onChange={event => setShuffleDraft(event.target.checked)} /><span /></span><span><strong>Shuffle on every launch</strong><small>{shuffleDraft ? 'Maps are played in a new random order each time.' : 'Maps follow the alphabetical list order below.'}</small></span></label><div className="map-heading"><div><span className="section-kicker">MAP POOL</span><h3>{mapLoading ? 'Scanning maps…' : `${mapSelection.length} / ${maps?.maps.length ?? 0} maps selected`}</h3></div><div className="map-tools"><button disabled={mapLoading || !maps} onClick={() => setMapSelection(maps?.maps || [])}>SELECT ALL</button><button disabled={mapLoading || !maps} onClick={() => setMapSelection([])}>CLEAR</button></div></div><div className="map-search"><Search size={16} /><input type="search" placeholder="Find a map…" value={mapSearch} onChange={event => setMapSearch(event.target.value)} /></div><div className="map-grid">{visibleMaps.map(map => <button key={map} type="button" disabled={mapLoading || !maps} aria-pressed={mapSelection.includes(map)} className={`map-option ${mapSelection.includes(map) ? 'chosen' : ''}`} onClick={() => toggleMap(map)}><span className="map-check">{mapSelection.includes(map) && <Check size={13} />}</span><span><strong>{gameMapName(map)}</strong><small>{map}</small></span></button>)}{!visibleMaps.length && <div className="map-empty">{mapLoading ? 'Looking for installed maps…' : 'No matching maps found. Check your game folder.'}</div>}</div><div className="form-footer"><div><Info size={17} /> Your rotation is generated at launch.{maps && maps.maps.length > 0 && maps.maps.every(map => mapSelection.includes(map)) ? ' With every map selected, maps you install later are included too.' : ''}</div><button className="button primary-button" disabled={!!busy || !maps || mapLoading} onClick={saveRotation}><Save size={16} /> Save launch options</button></div></div><aside className="settings-aside"><div className="panel"><div className="panel-icon featured"><ListFilter size={20} /></div><h3>Built for this game.</h3><p>Map availability and rotation syntax differ between engines. BotLANd uses this title’s own map format and skips anything missing from your installation.</p><div className="rotation-summary"><span>ROTATION ENGINE</span><strong>{game.engine}</strong><span>OUTPUT</span><strong>{game.id === 'mw3' ? 'DSR + map rotation' : game.id === 'bo2' ? 'ExecGTS + map rotation' : 'Map rotation config'}</strong></div></div><div className="aside-tip"><Info size={18} /><p>A different port lets you run multiple servers at once. Remember to adjust any firewall rules you use.</p></div></aside></div>}
          {tab === 'console' && <section className="panel console-panel"><div className="panel-heading"><div className="panel-icon"><Terminal size={19} /></div><div><span className="section-kicker">LIVE FEED</span><h2>Server console</h2></div><span className="console-state"><span className={game.status === 'running' ? 'online' : ''} />{game.status === 'running' ? `PID ${game.pid}` : 'OFFLINE'}</span></div><div className="console-window"><div className="console-toolbar"><span className="terminal-dots"><i /><i /><i /></span><span>{game.engine.toLowerCase().replaceAll(' ', '-')} / output</span><span className="terminal-live">{game.status === 'running' ? '● LIVE' : '● IDLE'}</span></div><div className="console-lines" ref={consoleLines} onScroll={event => { const element = event.currentTarget; followConsole.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40; }}>{game.logs.length ? game.logs.map((line: LogEntry, index) => <div className={`console-line ${line.level === 'error' ? 'error' : ''}`} key={index}><time>{gameTime(line.at)}</time><span>{line.message || ' '}</span></div>) : <div className="console-placeholder"><Terminal size={35} /><strong>Nothing on the wire yet.</strong><span>Start this server to see its output here.</span></div>}</div></div><div className="console-footnote"><Info size={16} /> Output is kept in memory for this app session only. Plutonium keys are redacted.</div></section>}
        </>}
      </div>
      <footer className="app-footer"><span>botLANd SERVER MANAGER</span><span>LOCAL CONTROL. YOUR SERVERS. YOUR RULES.</span></footer>
    </main>
  </div>;
}
