import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, ArrowLeft, ArrowRight, Check, ChevronRight, Clock3, Copy,
  ExternalLink, FolderOpen, Gamepad2, HardDrive, Info, LayoutDashboard,
  ListFilter, Map as MapIcon, Play, Radio, RefreshCw, Save, Search,
  Server, Settings2, ShieldCheck, SlidersHorizontal, Square, Terminal,
  TriangleAlert, X,
} from 'lucide-react';
import type { BotStatus, Game, GameId, LogEntry, MapData, Snapshot, FirewallStatus } from './types';
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
  // Runtime state outranks installation state: a server can still be running
  // after its game folder becomes unavailable, and it must keep its Stop control.
  if (game.status === 'running') return 'Running';
  if (game.status === 'starting') return 'Starting';
  if (game.status === 'restarting') return 'Restarting';
  if (game.status === 'stopping') return 'Stopping';
  if (!game.installed) return 'Not installed';
  return game.blockers.length ? 'Needs setup' : 'Ready to launch';
}
function displayError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, '');
}
function gameTime(date: string) { return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function gameMapName(name: string) { return name.replace(/^mp_/, '').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase()); }

function StateChip({ game }: { game: Game }) {
  const state = game.status === 'running' ? 'online' : game.status === 'restarting' ? 'attention' : !game.installed ? 'unavailable' : game.blockers.length ? 'attention' : 'ready';
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
function ConnectPanel({ game, busy, onCopy }: { game: Game; busy: boolean; onCopy: (address: string) => void }) {
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  if (game.status !== 'running') return null;
  const candidates = game.connect.candidates;
  const selected = candidates.find(candidate => candidate.connectAddress === selectedAddress)
    || (!game.connect.ambiguous ? candidates.find(candidate => candidate.address === game.connect.primaryAddress || candidate.connectAddress === game.connect.primaryAddress) || (candidates.length === 1 ? candidates[0] : undefined) : undefined);
  return <section className="panel connect-panel"><div className="panel-heading compact"><div><span className="section-kicker">JOIN THIS SERVER</span><h3>Connect address</h3></div><Radio size={18} /></div>
    {game.connect.ambiguous && <p className="setup-copy">More than one local network interface is available. Choose the address for the network your players use.</p>}
    {candidates.length > 1 && <label className="connect-choice" htmlFor={`connect-${game.id}`}>Network interface<select id={`connect-${game.id}`} value={selected?.connectAddress || ''} onChange={event => setSelectedAddress(event.target.value || null)}><option value="">Choose an interface</option>{candidates.map(candidate => <option key={`${candidate.adapter}-${candidate.connectAddress}`} value={candidate.connectAddress}>{candidate.label} · {candidate.address} ({candidate.scope})</option>)}</select></label>}
    <div className="connect-row"><code>{selected?.connectAddress || (!game.connect.ambiguous ? game.connect.primaryAddress : null) || 'No address available'}</code><button className="button outline-button" disabled={busy || !selected} onClick={() => { if (selected) onCopy(selected.connectAddress); }}><Copy size={14} /> Copy</button></div>
    {selected && <p className="connect-scope">{selected.label} · {selected.scope} interface ({selected.adapter})</p>}
    <p className="connect-disclosure">These are this PC&rsquo;s interface addresses, not a verified internet/WAN address. Players outside your network may need router port forwarding; Public mode alone does not make a server reachable.</p>
  </section>;
}
function RestartPanel({ game, busy, now, onChange }: { game: Game; busy: boolean; now: number; onChange: (enabled: boolean) => void }) {
  if (!game.installed && game.status === 'stopped') return null;
  const seconds = game.restart.nextAttemptAt ? Math.max(0, Math.ceil((new Date(game.restart.nextAttemptAt).getTime() - now) / 1000)) : null;
  return <section className="panel restart-panel"><div className="panel-heading compact"><div><span className="section-kicker">SERVER RECOVERY</span><h3>Automatic restart</h3></div></div>
    <label className="toggle-row"><span className={`toggle ${game.restart.enabled ? 'on' : ''}`}><input type="checkbox" checked={game.restart.enabled} disabled={busy} onChange={event => onChange(event.target.checked)} /><span /></span><span><strong>Restart after an unexpected exit</strong><small>{game.restart.enabled ? 'On' : 'Off by default'} · Manual Stop cancels pending retries.</small></span></label>
    {(game.status === 'restarting' || game.restart.cutOff || game.restart.attempts > 0) && <p className={`restart-state ${game.restart.cutOff ? 'restart-cutoff' : ''}`} role="status">{game.restart.cutOff ? 'Retry limit reached. Check the console, then start manually when ready.' : game.status === 'restarting' ? `Restart attempt ${game.restart.attempts + 1}${seconds !== null ? ` in ${seconds}s` : ' pending'}. Use Stop server to cancel.` : `${game.restart.attempts} restart attempt${game.restart.attempts === 1 ? '' : 's'} this session.`}</p>}
  </section>;
}
function OrphanWarning({ game, busy, onRescan }: { game: Game; busy: boolean; onRescan: () => void }) {
  if (!game.orphan) return null;
  return <div className="orphan-warning" role="status"><TriangleAlert size={18} /><div><strong>Possible server process detected (not managed)</strong><p>PID {game.orphan.pid} · UDP {game.orphan.port}. {game.orphan.reason} Inspect this PID in Windows Task Manager before starting another server. botLANd cannot adopt or stop it.</p><button className="inline-link" disabled={busy} onClick={onRescan}><RefreshCw size={14} /> Rescan processes</button></div></div>;
}
function KeyPanel({ game, draft, busy, onDraft, onSave, onRemove, onImport, onKeyPage, onScripts }: { game: Game; draft: string; busy: boolean; onDraft: (value: string) => void; onSave: () => void; onRemove: () => void; onImport: () => void; onKeyPage: () => void; onScripts: () => void }) {
  if (game.keyStatus === 'not-required') return null;
  const unavailable = game.keyStatus === 'unavailable';
  return <section className="panel key-panel"><div className="panel-heading compact"><div><span className="section-kicker">PLUTONIUM ACCESS</span><h3>Server key</h3></div><span className={`key-state ${game.keyStatus}`}>{game.keyStatus === 'stored' ? 'KEY STORED' : unavailable ? 'UNAVAILABLE' : 'KEY MISSING'}</span></div>
    <p className="setup-copy">{game.keyStatus === 'stored' ? 'A key is available for the next launch. Its value is never shown here.' : unavailable ? 'Key access is unavailable on this machine. Try again after restoring the key service.' : 'A server key is needed before this Plutonium server can launch.'}</p>
    {!unavailable && <form className="key-form" autoComplete="off" onSubmit={event => { event.preventDefault(); onSave(); }}><label htmlFor={`key-${game.id}`}>Paste your own server key</label><div className="key-input-row"><input id={`key-${game.id}`} type="password" value={draft} onChange={event => onDraft(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Paste key (hidden)" disabled={busy} /><button className="button primary-button" type="submit" disabled={busy || !draft.trim()}>{game.keyStatus === 'stored' ? 'Replace key' : 'Save key'}</button></div></form>}
    <div className="key-actions"><button className="inline-link" disabled={busy || unavailable} onClick={onImport}>Import from legacy launcher <ArrowRight size={14} /></button>{game.keyStatus === 'stored' && <button className="inline-link" disabled={busy} onClick={onRemove}>Remove saved key <X size={14} /></button>}</div>
    <p className="key-note">Import reads the launcher only when you click it. The scripts folder is optional; it is not required to start after you save a key. <button className="inline-link" disabled={busy} onClick={onScripts}>Choose scripts location</button></p>
    <button className="inline-link" disabled={busy} onClick={onKeyPage}>Get a key from Plutonium <ExternalLink size={14} /></button>
    <p className="key-warning"><Info size={15} /> The key is never displayed here, but the game still receives it on its process command line, where local process inspection may reveal it. Keep your machine and launchers private.</p>
  </section>;
}
type BotOperation = 'install' | 'update' | 'reinstall' | 'remove' | 'restore';
function BotPanel({ game, status, loading, error, busy, updateAvailable, onRetry, onAction, onChannel }: {
  game: Game; status: BotStatus | null; loading: boolean; error: string | null; busy: boolean; updateAvailable: boolean | null;
  onRetry: () => void; onAction: (operation: BotOperation, versionId?: string) => void; onChannel: (channel: 'stable' | 'development') => void;
}) {
  const [selectedVersion, setSelectedVersion] = useState('');
  const previous = status?.versions.find(version => version.versionId === selectedVersion) || status?.versions[0];
  const locked = busy || game.modBusy || game.status !== 'stopped' || !game.installed;
  const known = status?.state === 'installed';
  const unknown = status?.state === 'unknown';
  const developmentSupported = game.id === 'cod4' || game.id === 'bo2';
  return <section className="panel bot-panel"><div className="panel-heading compact"><div><span className="section-kicker">MOD MANAGEMENT</span><h3>Bot Warfare</h3></div>{updateAvailable === true && <span className="bot-update-badge">UPDATE AVAILABLE</span>}</div>
    {!game.installed ? <p className="setup-copy">Choose a game folder before managing Bot Warfare.</p> : loading ? <p className="setup-copy" role="status">Reading local Bot Warfare status…</p> : error ? <div className="bot-status-note" role="status"><Info size={16} /><span>{error} Your server controls remain available.</span><button className="inline-link" disabled={busy} onClick={onRetry}>Retry</button></div> : status && <>
      <div className="bot-state-row"><strong>{known ? 'Managed installation' : unknown ? 'Existing files (unmanaged)' : 'Not installed'}</strong>{game.modBusy && <span>Mod operation in progress…</span>}</div>
      <p className="bot-path" title={status.targetPath}>{status.targetPath}</p>
      {known && status.manifest && <dl className="bot-facts"><div><dt>Version</dt><dd>{status.manifest.ref} <small>({status.manifest.channel}, {status.manifest.refType})</small></dd></div><div><dt>Source</dt><dd>{status.manifest.repo}</dd></div><div><dt>SHA-256</dt><dd title={status.manifest.sha256}>{status.manifest.sha256}</dd></div><div><dt>Installed</dt><dd>{status.manifest.date}</dd></div></dl>}
      {unknown && <p className="bot-caution"><TriangleAlert size={16} /> Files already exist but their version is unknown. Installing will back up the existing mod before replacing it; review the confirmation first.</p>}
      <div className="bot-source"><strong>Upstream {status.source.ref || 'version unavailable'}</strong><span>{status.source.status}</span>{status.source.notes && <p>{status.source.notes}</p>}</div>
      <div className="bot-actions">
        {(status.state === 'not-installed' || unknown) && <button className="button primary-button" disabled={locked || !status.source.supported} onClick={() => onAction('install')}>Install Bot Warfare</button>}
        {known && <button className="button primary-button" disabled={locked || !status.source.supported || updateAvailable !== true} onClick={() => onAction('update')}>Update</button>}
        {known && <button className="button outline-button" disabled={locked || !status.source.supported} onClick={() => onAction('reinstall')}>Reinstall</button>}
        {known && <button className="button outline-button" disabled={locked} onClick={() => onAction('remove')}>Remove</button>}
      </div>
      {!!status.versions.length && <div className="bot-restore"><label htmlFor={`bot-version-${game.id}`}>Previous managed version</label><div><select id={`bot-version-${game.id}`} value={previous?.versionId || ''} disabled={locked} onChange={event => setSelectedVersion(event.target.value)}>{status.versions.map(version => <option key={version.versionId} value={version.versionId}>{version.date} · {version.manifest?.ref || 'Unknown ref'} ({version.manifest?.channel || 'unknown'})</option>)}</select><button className="button outline-button" disabled={locked || !previous} onClick={() => onAction('restore', previous?.versionId)}>Restore previous</button></div></div>}
      <details className="bot-advanced"><summary>Advanced: release channel</summary><p>Stable releases are recommended. Development builds may be untested and are an explicit opt-in.</p>{developmentSupported ? <div className="bot-channel"><button type="button" aria-pressed={status.channel === 'stable'} disabled={locked} onClick={() => onChannel('stable')}>Stable</button><button type="button" aria-pressed={status.channel === 'development'} disabled={locked} onClick={() => onChannel('development')}>Development</button></div> : <p>Development builds are not supported for this game; stable releases only.</p>}</details>
      <p className="bot-disclaimer">Only changes this game's Bot Warfare files. No mod is downloaded or installed automatically. Stop the server before making changes.</p>
    </>}
  </section>;
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
  const [keyDraft, setKeyDraft] = useState('');
  const [botState, setBotState] = useState<{ id: GameId; path: string; status: BotStatus | null; error: string | null; loading: boolean } | null>(null);
  const [botRevision, setBotRevision] = useState(0);
  const [clock, setClock] = useState(Date.now());
  // `busy` state updates asynchronously; this ref blocks a second click in the same tick.
  const busyLock = useRef(false);
  const mainPane = useRef<HTMLElement | null>(null);
  const focusAfterNavigation = useRef(false);
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
  useEffect(() => {
    if (focusAfterNavigation.current) {
      focusAfterNavigation.current = false;
      mainPane.current?.focus();
    }
  }, [selectedId, tab]);
  useEffect(() => {
    if (game?.status !== 'restarting' || !game.restart.nextAttemptAt) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [game?.status, game?.restart.nextAttemptAt]);
  const currentBotState = game && botState?.id === game.id && botState.path === game.gamePath ? botState : null;
  const maps = selectedId && game?.installed && mapCache[selectedId]?.gamePath === game.gamePath ? mapCache[selectedId] : undefined;
  useEffect(() => {
    if (!game) return;
    setPortDraft(String(game.options.port));
    setModeDraft(game.options.mode);
    setShuffleDraft(game.options.shuffle);
  }, [selectedId, game?.options.port, game?.options.mode, game?.options.shuffle]);
  useEffect(() => {
    // A scan abandoned by switching games never reaches its own `finally`, so clear the flag here.
    if (!selectedId || !game?.installed || !game.gamePath) { setMapLoading(false); return; }
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
  }, [selectedId, game?.installed, game?.gamePath, refreshRevision]);

  useEffect(() => {
    if (!selectedId || !game?.installed) { setFirewallStatus(null); return; }
    let active = true;
    setFirewallStatus(null);
    window.manager.firewallStatus(selectedId)
      .then(status => { if (active) setFirewallStatus(status); })
      .catch(() => { if (active) setFirewallStatus({ name: '', port: game?.activePort ?? game?.options.port ?? 0, state: 'unknown' }); });
    return () => { active = false; };
  }, [selectedId, game?.installed, game?.options.port, game?.activePort, refreshRevision]);

  useEffect(() => {
    if (!selectedId || !game?.installed || !game.gamePath) { setBotState(null); return; }
    let active = true;
    const id = selectedId;
    const path = game.gamePath;
    setBotState({ id, path, status: null, error: null, loading: true });
    window.manager.botStatus(id).then(status => { if (active) setBotState({ id, path, status, error: null, loading: false }); })
      .catch(() => { if (active) setBotState({ id, path, status: null, error: 'Bot Warfare status could not be read (offline or unavailable).', loading: false }); });
    return () => { active = false; };
  }, [selectedId, game?.installed, game?.gamePath, refreshRevision, botRevision]);

  // Keep the console on the newest output unless the user has scrolled up to read.
  const lastLog = game?.logs[game.logs.length - 1];
  useEffect(() => { followConsole.current = true; }, [selectedId, tab]);
  useEffect(() => {
    const element = consoleLines.current;
    if (tab === 'console' && element && followConsole.current) element.scrollTop = element.scrollHeight;
  }, [tab, selectedId, game?.logs.length, lastLog?.at, lastLog?.message]);

  const detectedGames = snapshot?.games.filter(entry => entry.installed) || [];
  // An installation can disappear while its server keeps running. Keep those
  // games visible so their Stop control never disappears from the UI.
  const activeUnavailableGames = snapshot?.games.filter(entry => !entry.installed && entry.status !== 'stopped') || [];
  const dashboardGames = snapshot?.games.filter(entry => entry.installed || entry.status !== 'stopped') || [];
  const missingGames = snapshot?.games.filter(entry => !entry.installed && entry.status === 'stopped') || [];
  const running = snapshot?.games.filter(entry => entry.status === 'running').length || 0;
  const ready = detectedGames.filter(entry => !entry.blockers.length && entry.status === 'stopped').length;
  const visibleMaps = useMemo(() => maps?.maps.filter(map => map.includes(mapSearch.trim().toLowerCase()) || gameMapName(map).toLowerCase().includes(mapSearch.trim().toLowerCase())) || [], [maps, mapSearch]);
  const savedMaps = game && maps ? (game.options.selectedMaps.length ? game.options.selectedMaps.filter(name => maps.maps.includes(name)) : maps.maps) : [];
  const missingMaps = game && maps ? game.options.selectedMaps.filter(name => !maps.maps.includes(name)) : [];
  const missingMode = !!game && !!maps && !maps.modes.some(option => option.value === game.options.mode);
  const savedMode = game ? (missingMode ? maps?.modes[0]?.value || game.options.mode : game.options.mode) : '';
  const rotationDirty = !!game && !!maps && !mapLoading && (portDraft !== String(game.options.port) || modeDraft !== savedMode || shuffleDraft !== game.options.shuffle || mapSelection.length !== savedMaps.length || mapSelection.some(name => !savedMaps.includes(name)));
  const unsavedDraft = (tab === 'configuration' && configDirty) || (tab === 'rotation' && rotationDirty);
  useEffect(() => {
    // Closing the window must not silently throw away a draft. The main process
    // turns this guard into a native confirmation dialog via will-prevent-unload.
    if (!unsavedDraft) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [unsavedDraft]);
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
  function selectTab(next: Tab) { if (next !== tab && canLeave()) { focusAfterNavigation.current = true; setKeyDraft(''); setTab(next); } }
  function goHome() { if (canLeave()) { if (selectedId !== null) focusAfterNavigation.current = true; setKeyDraft(''); setSelectedId(null); setTab('overview'); } }
  function refreshWorkspace() {
    if (busy || !canLeave()) return;
    setRefreshRevision(previous => previous + 1);
    action('refresh', () => window.manager.rescanOrphans());
  }
  async function syncSnapshot() {
    const version = snapshotVersion.current;
    const request = ++snapshotRequest.current;
    const data = await window.manager.snapshot();
    if (version === snapshotVersion.current && request === snapshotRequest.current) setSnapshot(data);
  }
  // A completed write must not be reported as a failed write merely because the
  // follow-up status read failed. The mutation and the refresh are separate steps.
  async function syncAfterAction(success?: string) {
    try {
      await syncSnapshot();
      if (success) setNotice({ text: success, error: false });
    } catch (error) {
      const text = `Action completed, but the status could not be refreshed: ${displayError(error)}. Use Refresh server status to try again.`;
      setNotice({ text: success ? `${success} ${text}` : text, error: true });
    }
  }
  async function action(label: string, task: () => Promise<unknown>, success?: string) {
    if (busy || busyLock.current) return;
    busyLock.current = true;
    setBusy(label); setNotice(null);
    try {
      await task();
      await syncAfterAction(success);
    } catch (error) {
      const text = displayError(error);
      setNotice({ text: label.startsWith('start-') && /Launch cancelled/i.test(text) ? 'Server launch cancelled.' : text, error: !(label.startsWith('start-') && /Launch cancelled/i.test(text)) });
    } finally { busyLock.current = false; setBusy(null); }
  }
  function openGame(id: GameId) { if (!canLeave()) return; if (id !== selectedId || tab !== 'overview') focusAfterNavigation.current = true; setKeyDraft(''); setSelectedId(id); setTab('overview'); setMapSearch(''); setNotice(null); }
  // Never surface key-related IPC errors: an underlying error could contain private input.
  async function keyAction(label: string, task: () => Promise<void>, success: string) {
    if (busy || busyLock.current) return;
    busyLock.current = true;
    setBusy(label); setNotice(null);
    try {
      await task();
      try { await syncSnapshot(); setNotice({ text: success, error: false }); }
      catch { setNotice({ text: 'Key action completed, but the key status could not be refreshed. Reopen this game to check it.', error: true }); }
    } catch { setNotice({ text: 'Key action failed. Check that the key service is available and try again.', error: true }); }
    finally { busyLock.current = false; setBusy(null); }
  }
  function savePastedKey(id: GameId) {
    const submitted = keyDraft.trim();
    if (!submitted || busy || busyLock.current) return;
    setKeyDraft('');
    keyAction('key-save', () => window.manager.saveKey(id, submitted), 'Server key saved. The paste field has been cleared.');
  }
  async function importLegacyKey(id: GameId) {
    if (busy || busyLock.current) return;
    busyLock.current = true;
    setBusy('key-import'); setNotice(null);
    try {
      let found: boolean;
      try { found = await window.manager.importKey(id); }
      catch { setNotice({ text: 'Key import failed. Check the optional scripts location and try again.', error: true }); return; }
      try {
        await syncSnapshot();
        setNotice({ text: found ? 'Key imported from the selected legacy scripts folder.' : 'No key was found in the selected legacy launcher. You can paste one instead or change the optional scripts location.', error: false });
      } catch {
        setNotice({ text: found ? 'Key imported, but the key status could not be refreshed. Reopen this game to check it.' : 'No key was found, and the key status could not be refreshed. Reopen this game to check it.', error: true });
      }
    } finally { busyLock.current = false; setBusy(null); }
  }
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
  function manageBot(target: Game, operation: BotOperation, versionId?: string) {
    if (busy || busyLock.current || target.modBusy || target.status !== 'stopped' || !target.installed) return;
    const prompts: Partial<Record<BotOperation, string>> = {
      reinstall: `Reinstall Bot Warfare for ${target.short}? Existing mod files may be replaced. Make sure you have a backup of custom changes.`,
      remove: `Remove Bot Warfare from ${target.short}? This deletes managed mod files. Back up any custom changes first.`,
      restore: `Restore the selected previous Bot Warfare version for ${target.short}? Current mod files will be replaced.`,
    };
    if (operation === 'install' && currentBotState?.status?.state === 'unknown' && !window.confirm(`Unmanaged Bot Warfare files already exist for ${target.short}. Install will back them up before replacing them. Continue?`)) return;
    if (prompts[operation] && !window.confirm(prompts[operation])) return;
    action(`bot-${operation}`, async () => { await window.manager.botAction(target.id, operation, versionId); setBotRevision(previous => previous + 1); }, `Bot Warfare ${operation} completed for ${target.short}.`);
  }
  function changeBotChannel(target: Game, channel: 'stable' | 'development') {
    if (busy || busyLock.current || target.modBusy || target.status !== 'stopped') return;
    if (channel === 'development' && !window.confirm(`Opt in to development builds for ${target.short}? These builds may be untested. Nothing is installed until you explicitly choose Install or Update.`)) return;
    action('bot-channel', async () => { await window.manager.setBotChannel(target.id, channel); setBotRevision(previous => previous + 1); }, `Bot Warfare channel set to ${channel}. No files were installed.`);
  }
  async function cancelStart(id: GameId) {
    if (cancelling) return;
    setCancelling(id);
    try {
      await window.manager.stop(id);
      try { await syncSnapshot(); }
      catch (error) { setNotice({ text: `Stop request completed, but the status could not be refreshed: ${displayError(error)}. Use Refresh server status to try again.`, error: true }); }
    }
    catch (error) { setNotice({ text: displayError(error), error: true }); }
    finally { setCancelling(null); }
  }
  async function copyDiagnostics() {
    if (busy || busyLock.current) return;
    busyLock.current = true; setBusy('copy-diagnostics'); setNotice(null);
    try {
      const copied = await window.manager.copyDiagnostics();
      setNotice({ text: copied ? 'Safe summary copied. Review it before sharing.' : 'Browser preview: diagnostics copy is simulated; the clipboard was not changed.', error: false });
    } catch { setNotice({ text: 'Could not copy diagnostics. Try again.', error: true }); }
    finally { busyLock.current = false; setBusy(null); }
  }
  async function copyConnectAddress(id: GameId, address: string) {
    if (busy || busyLock.current) return;
    busyLock.current = true; setBusy('copy-address'); setNotice(null);
    try {
      const copied = await window.manager.copyConnectAddress(id, address);
      setNotice({ text: copied ? document.documentElement.dataset.demo === 'true' ? 'Demo preview: Copy simulated; the clipboard was not changed.' : 'Connect address copied to clipboard.' : 'Could not copy this address. Refresh the running server and try again.', error: !copied });
    } catch (error) { setNotice({ text: displayError(error), error: true }); }
    finally { busyLock.current = false; setBusy(null); }
  }
  function launchControl(target: Game) {
    return target.status === 'running' || target.status === 'starting' || target.status === 'restarting'
      ? <button className="button stop-button" disabled={!!cancelling || (!!busy && busy !== `start-${target.id}`)} onClick={event => { event.stopPropagation(); if (target.status === 'starting') cancelStart(target.id); else action(`stop-${target.id}`, () => window.manager.stop(target.id)); }}><Square size={15} fill="currentColor" /> {target.status === 'starting' ? 'Cancel start' : 'Stop server'}</button>
      : <button className="button primary-button" disabled={!!busy || !target.installed || !!target.blockers.length || target.status !== 'stopped'} onClick={event => { event.stopPropagation(); action(`start-${target.id}`, () => window.manager.start(target.id)); }}><Play size={16} fill="currentColor" /> Start server</button>;
  }

  if (!snapshot) return <div className="loading-screen"><Logo /><span>PREPARING YOUR LOBBIES</span>{notice?.error ? <><p role="alert">{notice.text}</p><button className="button primary-button" onClick={() => { setNotice(null); syncSnapshot().catch(error => setNotice({ text: displayError(error), error: true })); }}>Retry status check</button></> : <div className="loading-line" />}</div>;
  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={goHome}><Logo /><div><strong>bot<span className="brand-word-accent">LAN</span>d</strong><small>SERVER MANAGER</small></div></button>
      <div className="nav-heading">WORKSPACE</div>
      <button className={`nav-item ${selectedId === null ? 'active' : ''}`} aria-current={selectedId === null ? 'page' : undefined} onClick={goHome}><LayoutDashboard size={18} /> Dashboard <ChevronRight size={15} className="nav-chevron" /></button>
      <div className="nav-heading game-heading">DETECTED GAMES <span>{String(detectedGames.length).padStart(2, '0')}</span></div>
      <div className="game-nav">{detectedGames.map(entry => <button key={entry.id} className={`nav-item game-nav-item ${selectedId === entry.id ? 'active' : ''}`} aria-current={selectedId === entry.id ? 'page' : undefined} onClick={() => openGame(entry.id)}><span className={`nav-game-glyph ${entry.family}`}>{gameCodes[entry.id].slice(0, 1)}</span><span className="nav-game-label">{entry.short}<small>{entry.engine}</small></span><span className={`nav-status ${entry.status === 'running' ? 'online' : entry.blockers.length ? 'attention' : ''}`} /></button>)}{!detectedGames.length && <span className="nav-empty">No game folders detected yet.</span>}</div>
       {!!activeUnavailableGames.length && <><div className="nav-heading missing-heading">ACTIVE / UNAVAILABLE <span>{String(activeUnavailableGames.length).padStart(2, '0')}</span></div><div className="game-nav">{activeUnavailableGames.map(entry => <button key={entry.id} className={`nav-item game-nav-item ${selectedId === entry.id ? 'active' : ''}`} aria-current={selectedId === entry.id ? 'page' : undefined} onClick={() => openGame(entry.id)}><span className={`nav-game-glyph ${entry.family}`}>{gameCodes[entry.id].slice(0, 1)}</span><span className="nav-game-label">{entry.short}<small>{statusLabel(entry)}</small></span><span className="nav-status online" /></button>)}</div></>}
       {!!missingGames.length && <><div className="nav-heading missing-heading">NOT INSTALLED <span>{String(missingGames.length).padStart(2, '0')}</span></div><div className="game-nav missing-nav">{missingGames.map(entry => <button key={entry.id} className={`nav-item game-nav-item ${selectedId === entry.id ? 'active' : ''}`} aria-current={selectedId === entry.id ? 'page' : undefined} onClick={() => openGame(entry.id)}><span className={`nav-game-glyph ${entry.family}`}>{gameCodes[entry.id].slice(0, 1)}</span><span className="nav-game-label">{entry.short}<small>Browse to set up</small></span></button>)}</div></>}
      <div className="sidebar-footer"><div className="footer-separator" /><div className="root-label"><HardDrive size={15} /> OPTIONAL SCRIPTS LOCATION</div><div className="root-path" title={snapshot.root}>{snapshot.root || 'Not selected'}</div><button className="root-button" disabled={!!busy} onClick={() => { if (canLeave()) action('root', () => window.manager.chooseRoot()); }}><FolderOpen size={15} /> Choose for key import <ArrowRight size={14} /></button><div className="sidebar-version">botLANd <span>LOCAL / {__APP_VERSION__}</span></div></div>
    </aside>
    <main ref={mainPane} className="main-pane" tabIndex={-1} aria-label={game ? `${game.title} — ${tabs.find(item => item.id === tab)?.label || 'Overview'}` : 'Dashboard'}>
      <header className="topbar"><div className="breadcrumbs"><span>WORKSPACE</span><ChevronRight size={14} /><strong>{game ? game.short.toUpperCase() : 'DASHBOARD'}</strong></div><div className="topbar-right"><span className="local-label"><span className="local-pulse" /> LOCAL MACHINE</span><button className="icon-button" aria-label="Refresh server status" title="Refresh server status" onClick={refreshWorkspace}><RefreshCw size={17} /></button></div></header>
      <div className="page-content">
        {notice && <div className={`notice ${notice.error ? 'notice-error' : 'notice-success'}`} role={notice.error ? 'alert' : 'status'}>{notice.error ? <TriangleAlert size={17} /> : <Check size={17} />}<span>{notice.text}</span><button onClick={() => setNotice(null)} aria-label="Dismiss"><X size={16} /></button></div>}
        {!game ? <>
          <section className="dashboard-intro"><div><div className="eyebrow"><span className="eyebrow-line" /> YOUR COMMAND CENTER</div><h1>Make the lobby <em>yours.</em></h1><p>Manage the games detected on this PC. Add another game by choosing its installed folder below.</p></div><div className="intro-mark" aria-hidden="true"><span>BL<span>.</span></span></div></section>
          {snapshot.games.some(entry => entry.orphan) && <section className="dashboard-orphans" role="status"><div><TriangleAlert size={18} /><span><strong>Possible unmanaged server processes</strong><small>{snapshot.games.filter(entry => entry.orphan).map(entry => `${entry.short}: PID ${entry.orphan?.pid}, UDP ${entry.orphan?.port}`).join(' · ')}. Inspect these PIDs in Windows Task Manager; botLANd cannot adopt or stop them.</small></span></div><button className="button outline-button" disabled={!!busy} onClick={() => action('rescan-orphans', () => window.manager.rescanOrphans(), 'Process scan complete.')}><RefreshCw size={15} /> Rescan processes</button></section>}
           <div className="stats-row"><div className="stat-card"><div className="stat-icon"><Server size={21} /></div><div><span>GAMES DETECTED</span><strong>{String(detectedGames.length).padStart(2, '0')} <small>/ {String(snapshot.games.length).padStart(2, '0')} SUPPORTED</small></strong></div></div><div className="stat-card"><div className="stat-icon green"><Activity size={21} /></div><div><span>RUNNING NOW</span><strong>{String(running).padStart(2, '0')} <small>/ LIVE SESSIONS</small></strong></div></div><div className="stat-card"><div className="stat-icon orange"><ShieldCheck size={21} /></div><div><span>READY TO LAUNCH</span><strong>{String(ready).padStart(2, '0')} <small>/ {String(detectedGames.length).padStart(2, '0')} DETECTED</small></strong></div></div></div>
          {(!!missingGames.length || detectedGames.some(entry => entry.blockers.length)) && <section className="setup-panel"><div><span className="section-kicker">SETUP CHECKLIST</span><h2>{detectedGames.length ? 'Finish setting up your games' : 'Set up your first lobby'}</h2><ol><li>Install an owned game, then rescan or browse to its game folder.</li><li>Follow its compatible engine guide and install Bot Warfare plus the required server config.</li><li>For Plutonium titles, add your own server key on the game page. The scripts folder is only for optional key import.</li><li>Resolve the game's preflight checks, select maps and settings, then Start.</li></ol></div><button className="button outline-button" disabled={!!busy} onClick={() => action('rescan', () => window.manager.rescanInstallations(), 'Installation scan complete.')}><RefreshCw size={16} /> Rescan installations</button></section>}
           <div className="section-heading"><div><span className="section-kicker">DETECTED ON THIS PC</span><h2>Game servers <span className="heading-count">{String(dashboardGames.length).padStart(2, '0')}</span></h2></div><span className="section-sub">SELECT A GAME TO MANAGE ITS SERVER <ArrowRight size={15} /></span></div>
           {!dashboardGames.length && <div className="empty-install"><FolderOpen size={27} /><div><strong>No game folders detected.</strong><p>Install a supported game, rescan, or select a game below to browse to an existing folder. Engine, mods and config are checked before launch.</p></div></div>}
          <div className="server-grid">{dashboardGames.map(entry => <div key={entry.id} className={`server-card accent-${entry.family}`}><div className={`card-art ${covers[entry.id] ? 'has-image' : ''}`} style={covers[entry.id] ? { backgroundImage: `url("${covers[entry.id]}")` } : undefined}><div className="card-grid-pattern" /><div className="card-ring ring-a" /><div className="card-ring ring-b" /><span className="card-art-number">{gameNumbers[entry.id]}</span><span className="card-art-code">{gameCodes[entry.id]}</span></div><div className="server-card-body"><div className="card-topline"><span>{entry.engine.toUpperCase()}</span><span className={`card-visibility ${entry.options.lan ? '' : 'public'}`}>{entry.options.lan ? 'LAN' : 'PUBLIC'}</span><StateChip game={entry} /></div><h3>{entry.title}</h3>{snapshot.updates[entry.id]?.updateAvailable === true && <span className="bot-update-badge card-bot-badge">BOT WARFARE UPDATE</span>}<p>{entry.subtitle} <span className="dot-separator">·</span> UDP {entry.activePort ?? entry.options.port}{entry.activePort != null && entry.activePort !== entry.options.port ? ` (next: ${entry.options.port})` : ''}</p>{entry.orphan && <span className="card-orphan"><TriangleAlert size={12} /> Possible unmanaged PID {entry.orphan.pid}</span>}<div className="card-actions">{launchControl(entry)}<button className="card-open" onClick={event => { event.stopPropagation(); openGame(entry.id); }}>MANAGE <ArrowRight size={16} /></button></div></div></div>)}</div>
          {!!missingGames.length && <section className="missing-section"><div className="section-heading"><div><span className="section-kicker">ADD A GAME</span><h2>Not installed <span className="heading-count">{String(missingGames.length).padStart(2, '0')}</span></h2></div><span className="section-sub">NO GAME FOLDER DETECTED</span></div><div className="missing-list">{missingGames.map(entry => <div className="missing-row" key={entry.id}><span className={`nav-game-glyph ${entry.family}`}>{gameCodes[entry.id].slice(0, 1)}</span><div><strong>{entry.title}</strong><small>{entry.engine} · Choose an existing game folder to begin.</small></div><button className="button outline-button" disabled={!!busy} onClick={() => action('folder', () => window.manager.chooseFolder(entry.id))}><FolderOpen size={15} /> Browse folder</button><button className="inline-link" onClick={() => openGame(entry.id)}>Setup <ArrowRight size={14} /></button></div>)}</div></section>}
           <section className="panel update-settings"><div className="panel-heading compact"><div><span className="section-kicker">SETTINGS</span><h2>Bot Warfare update checks</h2></div><button className="button outline-button" disabled={!!busy} onClick={() => action('check-updates', () => window.manager.checkBotUpdates(), 'Update check finished. See per-game status below; no mods were installed.')}><RefreshCw size={15} /> Check now</button></div><label className="toggle-row"><span className={`toggle ${snapshot.updatesEnabled ? 'on' : ''}`}><input type="checkbox" checked={snapshot.updatesEnabled} disabled={!!busy} onChange={event => action('update-checks', () => window.manager.setUpdateChecks(event.target.checked), `Automatic update checks ${event.target.checked ? 'enabled' : 'disabled'}.`)} /><span /></span><span><strong>Check for updates automatically</strong><small>{snapshot.updatesEnabled ? 'On' : 'Off'} · Checks never install or change game files.</small></span></label><div className="update-status-list" aria-label="Update check results">{detectedGames.map(entry => <div key={entry.id}><strong>{entry.short}</strong><span>{snapshot.updates[entry.id]?.status || 'Not checked yet'}{snapshot.updates[entry.id]?.updateAvailable === true ? ' · Update available' : ''}</span></div>)}</div><p className="update-disclosure"><Info size={16} /> On by default: botLANd contacts api.github.com at most once every 18 hours using a standard request to look for Bot Warfare versions. No account or keys are sent. Checks are skipped offline; no updates install automatically. You can turn this off here at any time.</p></section>
            <section className="panel diagnostics-panel"><div><span className="section-kicker">SUPPORT</span><h2>Copy diagnostics</h2><p>Copies only the app version, platform, and per-game readiness counts. No logs, paths, addresses, keys, or config values. Review the summary before sharing it.</p></div><button className="button outline-button" disabled={!!busy} onClick={copyDiagnostics}><Copy size={15} /> Copy diagnostics</button></section>
            <div className="dashboard-note"><Info size={17} /><span>Only detected games appear as server cards. Preflight checks determine whether Start is available. Public players also need the game's UDP port opened or forwarded on their router.</span></div>
        </> : <>
          <div className="detail-back"><button onClick={goHome}><ArrowLeft size={16} /> ALL SERVERS</button><span>/</span><span>{game.short.toUpperCase()}</span></div>
          <section className={`detail-hero accent-${game.family} ${heroes[game.id] ? 'has-image' : ''}`} style={heroes[game.id] ? { backgroundImage: `linear-gradient(90deg,rgba(24,25,23,.95) 0%,rgba(24,25,23,.83) 47%,rgba(24,25,23,.43) 100%),url("${heroes[game.id]}")` } : undefined}><div className="detail-hero-art" aria-hidden="true"><div className="hero-arc" /><span>{gameCodes[game.id]}</span></div><div className="detail-hero-content"><div className="eyebrow"><span className="eyebrow-line" /> {game.engine.toUpperCase()} <span className="eyebrow-divider">/</span> DEDICATED SERVER</div><h1>{game.title}</h1><p>{game.subtitle} <span>·</span> {game.options.lan ? 'LAN' : 'PUBLIC'} BOT SERVER</p><div className="detail-hero-bottom"><StateChip game={game} />{snapshot.updates[game.id]?.updateAvailable === true && <span className="bot-update-badge">BOT WARFARE UPDATE</span>}<span className="hero-port"><Radio size={15} /> UDP {game.activePort ?? game.options.port}{game.activePort != null && game.activePort !== game.options.port ? ` (next: ${game.options.port})` : ''}</span><span className="hero-port"><Gamepad2 size={15} /> {game.engine}</span>{game.installed && <VisibilitySwitch game={game} disabled={!!busy} onChange={next => changeVisibility(game, next)} />}</div></div><div className="detail-hero-action">{game.installed || game.status !== 'stopped' ? launchControl(game) : <button className="button primary-button" disabled={!!busy} onClick={() => action('folder', () => window.manager.chooseFolder(game.id))}><FolderOpen size={16} /> Browse game folder</button>}</div></section>
          <nav className="detail-tabs" aria-label="Game sections">{tabs.map(item => <button key={item.id} className={tab === item.id ? 'selected' : ''} aria-current={tab === item.id ? 'page' : undefined} disabled={!game.installed && item.id !== 'overview'} onClick={() => selectTab(item.id)}><item.icon size={17} />{item.label}</button>)}</nav>
          {tab === 'overview' && <div className="detail-layout"><div className="detail-primary"><OrphanWarning game={game} busy={!!busy} onRescan={() => action('rescan-orphans', () => window.manager.rescanOrphans(), 'Process scan complete.')} /><ConnectPanel key={`${game.id}-${game.startedAt || ''}`} game={game} busy={!!busy} onCopy={address => copyConnectAddress(game.id, address)} /><RestartPanel game={game} busy={!!busy} now={clock} onChange={enabled => action('auto-restart', () => window.manager.setAutoRestart(game.id, enabled), `Automatic restart ${enabled ? 'enabled' : 'disabled'} for ${game.short}.`)} /><section className="panel title-setup"><div className="panel-heading"><div className="panel-icon"><Gamepad2 size={19} /></div><div><span className="section-kicker">GETTING STARTED</span><h2>Setup checklist</h2></div></div><div className="setup-checks"><div className={game.installed ? 'done' : ''}>{game.installed ? <Check size={17} /> : <span>1</span>}<div><strong>Find your game folder</strong><small>{game.installed ? `Detected (${game.pathSource === 'steam' ? 'Steam' : 'selected manually'}).` : 'Install your owned game, then choose its folder.'}</small></div></div><div className={!game.blockers.length && game.installed ? 'done' : ''}>{!game.blockers.length && game.installed ? <Check size={17} /> : <span>2</span>}<div><strong>Install the compatible engine and Bot Warfare</strong><small>Check your engine's setup guide and the preflight results below for missing files.</small><button className="inline-link" disabled={!!busy} onClick={() => action('engine-guide', () => window.manager.openEngineGuide(game.id))}>Open {game.engine} setup guide <ExternalLink size={14} /></button></div></div><div className={game.keyStatus === 'not-required' || game.keyStatus === 'stored' ? 'done' : ''}>{game.keyStatus === 'not-required' || game.keyStatus === 'stored' ? <Check size={17} /> : <span>3</span>}<div><strong>{game.keyStatus === 'not-required' ? 'No server key required' : 'Add your Plutonium server key'}</strong><small>{game.keyStatus === 'stored' ? 'A saved key is available.' : game.keyStatus === 'not-required' ? 'This engine does not use Plutonium keys.' : 'Paste your own key or explicitly import it from a legacy launcher below.'}</small></div></div><div className={!game.blockers.length && game.installed ? 'done' : ''}>{!game.blockers.length && game.installed ? <Check size={17} /> : <span>4</span>}<div><strong>Resolve preflight, configure, then Start</strong><small>Choose your maps, server settings and visibility; launch is blocked until required files are present.</small></div></div></div></section><section className="panel"><div className="panel-heading"><div className="panel-icon"><ShieldCheck size={19} /></div><div><span className="section-kicker">PREFLIGHT CHECK</span><h2>Server readiness</h2></div><span className={`readiness-pill ${!game.installed || game.blockers.length ? 'bad' : 'good'}`}>{!game.installed ? 'GAME NOT INSTALLED' : game.blockers.length ? `${game.blockers.length} ISSUE${game.blockers.length === 1 ? '' : 'S'}` : 'ALL CHECKS PASSED'}</span></div>{game.installed && !game.blockers.length && !game.warnings.length ? <div className="all-clear"><div><Check size={20} /></div><div><strong>Everything looks good.</strong><span>Your files and launch dependencies are in place. Ready when you are.</span></div></div> : <div className="check-list">{!game.installed && !game.blockers.length && <div className="check-item error"><FolderOpen size={17} /><span>No installed game folder was detected. Browse to your existing installation to continue.</span></div>}{game.blockers.map((issue, index) => <div className="check-item error" key={`b-${index}`}><TriangleAlert size={17} /><span>{issue}</span></div>)}{game.warnings.map((issue, index) => <div className="check-item warning" key={`w-${index}`}><Info size={17} /><span>{issue}</span></div>)}{game.installed && !game.blockers.length && <div className="check-item success"><Check size={17} /><span>Launch dependencies and config found.</span></div>}</div>}</section>
          {game.installed && <section className="panel"><div className="panel-heading"><div className="panel-icon"><SlidersHorizontal size={19} /></div><div><span className="section-kicker">AT A GLANCE</span><h2>Current setup</h2></div><button className="text-action" onClick={() => selectTab('configuration')}>EDIT SETTINGS <ArrowRight size={15} /></button></div><div className="quick-grid"><div><span>PLAYER SLOTS</span><strong>{game.config.sv_maxclients || '—'}</strong></div><div><span>BOT FILL TARGET</span><strong>{game.config.bots_manage_fill || '—'}</strong></div><div><span>MAPS SELECTED</span><strong>{maps ? (game.options.selectedMaps.length || maps.maps.length) : '—'}</strong></div><div><span>GAME MODE</span><strong>{maps?.modes.find(mode => mode.value === game.options.mode)?.label || game.options.mode.toUpperCase()}</strong></div></div></section>}</div>
          <div className="detail-secondary"><BotPanel key={game.id} game={game} status={currentBotState?.status || null} loading={!!game.installed && (!currentBotState || currentBotState.loading)} error={currentBotState?.error || null} busy={!!busy} updateAvailable={snapshot.updates[game.id]?.updateAvailable ?? null} onRetry={() => setBotRevision(previous => previous + 1)} onAction={(operation, versionId) => manageBot(game, operation, versionId)} onChannel={channel => changeBotChannel(game, channel)} /><KeyPanel key={game.id} game={game} draft={keyDraft} busy={!!busy} onDraft={setKeyDraft} onSave={() => savePastedKey(game.id)} onRemove={() => { if (window.confirm('Remove the saved server key? The next launch will need a key.')) keyAction('key-remove', () => window.manager.removeKey(game.id), 'Saved key removed.'); }} onImport={() => importLegacyKey(game.id)} onKeyPage={() => action('key-page', () => window.manager.openKeyPage())} onScripts={() => action('root', () => window.manager.chooseRoot())} /><section className="panel path-panel"><div className="section-kicker">INSTALLATION</div><h3>Game folder</h3><div className="path-display" title={game.gamePath}><FolderOpen size={18} /><span>{game.gamePath || 'Not detected'}</span></div><p className="path-source">{game.pathSource === 'steam' ? 'Detected in your Steam library' : game.pathSource === 'manual' ? 'Selected manually' : 'No folder selected'}</p><button className="outline-button full-width" disabled={!!busy} onClick={() => action('folder', () => window.manager.chooseFolder(game.id))}><FolderOpen size={16} /> Browse game folder</button><button className="inline-link engine-link" disabled={!!busy} onClick={() => action('engine-guide', () => window.manager.openEngineGuide(game.id))}>{game.engine} setup guide <ExternalLink size={14} /></button><div className="panel-divider" /><div className="section-kicker">CONFIG FILE</div><div className="path-display smaller" title={game.configPath}><Settings2 size={17} /><span>{game.configPath || 'Not found'}</span></div>{game.installed && game.blockers.some(issue => issue.startsWith('Server config missing')) && <button className="outline-button full-width" disabled={!!busy} onClick={() => action('starter', () => window.manager.createStarterConfig(game.id), 'Starter config created. Review its settings before hosting.')}><Settings2 size={16} /> Create starter config</button>}<button className="inline-link" disabled={!!busy || !game.installed || game.blockers.some(issue => issue.startsWith('Server config missing'))} onClick={() => action('open', () => window.manager.openConfig(game.id))}>Open original config <ExternalLink size={14} /></button>{game.installed && <><div className="panel-divider" /><div className="section-kicker">WINDOWS FIREWALL</div><FirewallPanel game={game} status={firewallStatus} busy={!!busy} onApply={() => changeFirewall(game, true)} onRemove={() => changeFirewall(game, false)} /></>}<div className="panel-divider" /><div className="section-kicker">GAME ARTWORK</div><p className="artwork-note">Loaded from your local Steam cache. Custom images are never included in the installer.</p><div className="artwork-actions"><button onClick={() => changeArtwork(game.id, 'cover')} disabled={!!busy}>Change cover</button><button onClick={() => changeArtwork(game.id, 'hero')} disabled={!!busy}>Change header</button><button onClick={() => restoreArtwork(game.id)} disabled={!!busy}>Use Steam art</button></div></section><section className="panel activity-panel"><div className="panel-heading compact"><div><span className="section-kicker">RECENT ACTIVITY</span><h3>Server output</h3></div><button className="text-action" onClick={() => selectTab('console')}>VIEW ALL <ArrowRight size={15} /></button></div>{game.logs.length ? game.logs.slice(-3).reverse().map((line, index) => <div className="activity-line" key={index}><span className={line.level === 'error' ? 'activity-error' : ''} /><p>{line.message}</p><time>{gameTime(line.at)}</time></div>) : <div className="activity-empty"><Clock3 size={19} /> No activity yet. Start the server to see its output.</div>}</section></div></div>}
          {tab === 'configuration' && <ConfigWorkspace key={game.id} game={game} maps={maps} refreshRevision={refreshRevision} onDirtyChange={setConfigDirty} onBusyChange={setConfigBusy} />}
          {tab === 'rotation' && <div className="settings-layout"><div className="panel rotation-panel"><div className="panel-heading"><div className="panel-icon"><MapIcon size={19} /></div><div><span className="section-kicker">THE NEXT MATCH</span><h2>Maps & modes</h2></div></div><p className="panel-description">Only maps found in this installation are listed. A fresh rotation is written when the server starts.</p>{(missingMaps.length > 0 || missingMode) && <div className="config-notice error" role="alert"><TriangleAlert size={16} /> {missingMaps.length > 0 ? `${missingMaps.length} saved map${missingMaps.length === 1 ? '' : 's'} no longer installed. ` : ''}{missingMode ? 'The saved game mode is unavailable. ' : ''}Save updated launch options before starting.</div>}<div className="rotation-controls"><label className="form-field"><span>Game mode</span><small>Available modes for this game</small><select value={modeDraft} disabled={mapLoading || !maps} onChange={event => setModeDraft(event.target.value)}>{maps?.modes?.length ? maps.modes.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>) : <option value={modeDraft}>{modeDraft}</option>}</select></label><label className="form-field"><span>UDP port</span><small>Use a unique port for simultaneous servers</small><input type="number" min="1024" max="65535" value={portDraft} disabled={mapLoading || !maps} onChange={event => setPortDraft(event.target.value)} /></label></div><label className="toggle-row"><span className={`toggle ${shuffleDraft ? 'on' : ''}`}><input type="checkbox" checked={shuffleDraft} disabled={mapLoading || !maps} onChange={event => setShuffleDraft(event.target.checked)} /><span /></span><span><strong>Shuffle on every launch</strong><small>{shuffleDraft ? 'Maps are played in a new random order each time.' : 'Maps follow the alphabetical list order below.'}</small></span></label><div className="map-heading"><div><span className="section-kicker">MAP POOL</span><h3>{mapLoading ? 'Scanning maps…' : `${mapSelection.length} / ${maps?.maps.length ?? 0} maps selected`}</h3></div><div className="map-tools"><button disabled={mapLoading || !maps} onClick={() => setMapSelection(maps?.maps || [])}>SELECT ALL</button><button disabled={mapLoading || !maps} onClick={() => setMapSelection([])}>CLEAR</button></div></div><div className="map-search"><Search size={16} /><input type="search" aria-label="Find a map" placeholder="Find a map…" value={mapSearch} onChange={event => setMapSearch(event.target.value)} /></div><div className="map-grid">{visibleMaps.map(map => <button key={map} type="button" disabled={mapLoading || !maps} aria-pressed={mapSelection.includes(map)} className={`map-option ${mapSelection.includes(map) ? 'chosen' : ''}`} onClick={() => toggleMap(map)}><span className="map-check">{mapSelection.includes(map) && <Check size={13} />}</span><span><strong>{gameMapName(map)}</strong><small>{map}</small></span></button>)}{!visibleMaps.length && <div className="map-empty">{mapLoading ? 'Looking for installed maps…' : 'No matching maps found. Check your game folder.'}</div>}</div><div className="form-footer"><div><Info size={17} /> Your rotation is generated at launch.{maps && maps.maps.length > 0 && maps.maps.every(map => mapSelection.includes(map)) ? ' With every map selected, maps you install later are included too.' : ''}</div><button className="button primary-button" disabled={!!busy || !maps || mapLoading} onClick={saveRotation}><Save size={16} /> Save launch options</button></div></div><aside className="settings-aside"><div className="panel"><div className="panel-icon featured"><ListFilter size={20} /></div><h3>Built for this game.</h3><p>Map availability and rotation syntax differ between engines. BotLANd uses this title’s own map format and skips anything missing from your installation.</p><div className="rotation-summary"><span>ROTATION ENGINE</span><strong>{game.engine}</strong><span>OUTPUT</span><strong>{game.id === 'mw3' ? 'DSR + map rotation' : game.id === 'bo2' ? 'ExecGTS + map rotation' : 'Map rotation config'}</strong></div></div><div className="aside-tip"><Info size={18} /><p>A different port lets you run multiple servers at once. Remember to adjust any firewall rules you use.</p></div></aside></div>}
          {tab === 'console' && <section className="panel console-panel"><div className="panel-heading"><div className="panel-icon"><Terminal size={19} /></div><div><span className="section-kicker">LIVE FEED</span><h2>Server console</h2></div><span className="console-state"><span className={game.status === 'running' ? 'online' : ''} />{game.status === 'running' ? `PID ${game.pid}` : game.status === 'restarting' ? 'RESTARTING' : 'OFFLINE'}</span></div><div className="console-window"><div className="console-toolbar"><span className="terminal-dots"><i /><i /><i /></span><span>{game.engine.toLowerCase().replaceAll(' ', '-')} / output</span><span className="terminal-live">{game.status === 'running' ? '● LIVE' : '● IDLE'}</span></div><div className="console-lines" role="log" aria-label="Server output" aria-live="off" tabIndex={0} ref={consoleLines} onScroll={event => { const element = event.currentTarget; followConsole.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40; }}>{game.logs.length ? game.logs.map((line: LogEntry, index) => <div className={`console-line ${line.level === 'error' ? 'error' : ''}`} key={index}><time>{gameTime(line.at)}</time><span className={`console-source ${line.source || 'manager'}`}>{line.source || 'manager'}</span><span>{line.message || ' '}</span></div>) : <div className="console-placeholder"><Terminal size={35} /><strong>Nothing on the wire yet.</strong><span>Start this server to see its output here.</span></div>}</div></div><div className="console-footnote"><Info size={16} /> {document.documentElement.dataset.demo === 'true' ? 'Browser preview: output is simulated and no log file is written.' : <>Recent output is shown here; session logs are also saved to disk in botLANd&rsquo;s app data folder. Keys are redacted, but other server output may be sensitive — review logs before sharing.</>}</div></section>}
        </>}
      </div>
      <footer className="app-footer"><span>botLANd SERVER MANAGER</span><span>LOCAL CONTROL. YOUR SERVERS. YOUR RULES.</span></footer>
    </main>
  </div>;
}
