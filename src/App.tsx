import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity, ArrowLeft, ArrowRight, Check, ChevronRight, Clock3, Copy,
  Download, ExternalLink, FolderOpen, Gamepad2, Info, KeyRound, LayoutDashboard,
  ListFilter, Map as MapIcon, Play, Radio, RefreshCw, Save, Search,
  Server, Settings2, ShieldCheck, SlidersHorizontal, Square, Terminal,
  TriangleAlert, X,
} from 'lucide-react';
import type { ArtworkKind, BotStatus, Game, GameId, LogEntry, MapData, Snapshot, FirewallStatus } from './types';
import ConfigWorkspace from './ConfigWorkspace';
import { t, tp, translate, useLocale, setLocale, localeTag, LOCALES, type MessageKey } from './i18n';
import './artwork.css';

type Tab = 'overview' | 'configuration' | 'rotation' | 'console';
const gameNumbers: Record<GameId, string> = { cod4: '01', waw: '02', mw2: '03', bo1: '04', mw3: '05', bo2: '06' };
const gameCodes: Record<GameId, string> = { cod4: 'IW3', waw: 'T4', mw2: 'IW4', bo1: 'T5', mw3: 'IW5', bo2: 'T6' };
const tabs: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: 'overview', label: 'Overview' as MessageKey, icon: Activity },
  { id: 'configuration', label: 'Configuration' as MessageKey, icon: SlidersHorizontal },
  { id: 'rotation', label: 'Maps & modes' as MessageKey, icon: MapIcon },
  { id: 'console', label: 'Console' as MessageKey, icon: Terminal },
];

function statusLabel(game: Game, firewall?: FirewallStatus | null) {
  // Runtime state outranks installation state: a server can still be running
  // after its game folder becomes unavailable, and it must keep its Stop control.
  if (game.status === 'running') return t('Running');
  if (game.status === 'starting') return t('Starting');
  if (game.status === 'restarting') return t('Restarting');
  if (game.status === 'stopping') return t('Stopping');
  if (!game.installed) return t('Not detected');
  if (game.engineBusy) return t('Updating engine');
  return game.blockers.length ? t('Needs setup') : game.id === 'bo1' && (firewall?.state !== 'any' || firewall.managed !== true) ? t('Check public firewall') : t('Ready to launch');
}
function displayError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': Error: /, '');
}
// Fixed, non-secret key-service messages from the main process (see manager.cjs / key-store.cjs).
const knownKeyErrors = [
  'The saved key file (keys.json) is damaged. Click Reset key storage, then paste the key again.',
  'Windows encryption is unavailable for this user, so the key cannot be stored securely.',
  'Secure key storage is unavailable.',
  'Stored server keys are unavailable.',
  'Could not encrypt server key.',
  'Invalid server key.',
  'Key storage was not damaged, so nothing was changed.',
];
function gameTime(date: string) { return new Date(date).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function gameMapName(name: string) { return name.replace(/^mp_/, '').replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase()); }
// Artwork is served by a dedicated scheme: the browser caches and decodes it,
// and no base64 copy crosses IPC or sits in React state.
function artworkUrl(id: GameId, kind: ArtworkKind, version: string) { return `botland-art://artwork/${id}/${kind}?v=${version}`; }
function artworkVersion(gamePath: string, revision: number) {
  let hash = 0;
  for (const char of `${gamePath}|${revision}`) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash).toString(36);
}
// Stable keys for a sliding window of log lines: an index key would change for
// every line each time the oldest line drops off, re-rendering the whole list.
function logKeys(lines: LogEntry[]) {
  const seen = new Map<string, number>();
  return lines.map(line => {
    const base = `${line.at}|${line.source || ''}|${line.message}`;
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    return `${base}#${count}`;
  });
}
function formatDate(date: string) { const parsed = new Date(date); return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleString(localeTag()); }
// Update-check status codes come from the main process; show them as plain language.
const updateStatusText: Record<string, string> = {
  current: 'Up to date with the latest check',
  'not-modified': 'Checked; no upstream change',
  cached: 'Checked recently',
  offline: 'Could not reach GitHub; retrying later',
  'rate-limited': 'GitHub rate limit reached; retrying later',
  unsupported: 'No verified upstream release',
  disabled: 'Update checks are off',
};
function updateStatus(code: string) { return translate(updateStatusText[code] || code); }
// Plain-language names for the action that currently holds the busy flag.
const busyTexts: Record<string, string> = {
  'fw-apply': 'Waiting for the firewall change', 'fw-remove': 'Waiting for the firewall change',
  rotation: 'Saving launch options', visibility: 'Saving visibility', refresh: 'Refreshing status',
  rescan: 'Scanning installations', 'rescan-orphans': 'Scanning processes', folder: 'Choosing a game folder',
  plutonium: 'Updating Plutonium', 'check-updates': 'Checking for updates', 'update-checks': 'Saving the update setting',
  'auto-restart': 'Saving automatic restart', artwork: 'Updating artwork', 'key-save': 'Saving the server key', 'key-reset': 'Resetting key storage',
  'key-remove': 'Removing the server key', starter: 'Creating the server config',
  'copy-diagnostics': 'Copying diagnostics', 'copy-address': 'Copying the address', 'engine-guide': 'Opening the setup guide',
  'key-page': 'Opening the key page', open: 'Opening the config', 'bot-channel': 'Saving the release channel',
};
function busyText(label: string): string {
  if (label.startsWith('start-')) return 'Starting a server';
  if (label.startsWith('engine-')) return 'Installing or updating engine files';
  if (label.startsWith('bot-') && label !== 'bot-channel') return 'Changing Bot Warfare files';
  return busyTexts[label] || 'Working';
}

function StateChip({ game, firewall }: { game: Game; firewall?: FirewallStatus | null }) {
  const state = game.status === 'running' ? 'online' : (game.status === 'restarting' || game.status === 'starting' || game.status === 'stopping') ? 'attention' : !game.installed ? 'unavailable' : game.engineBusy || game.blockers.length || (game.id === 'bo1' && (firewall?.state !== 'any' || firewall.managed !== true)) ? 'attention' : 'ready';
  return <span className={`state-chip ${state}`}><span className="state-dot" />{statusLabel(game, firewall)}</span>;
}
function VisibilitySwitch({ game, disabled, onChange }: { game: Game; disabled: boolean; onChange: (lan: boolean) => void }) {
  if (game.id === 'bo1') return <span className="visibility-locked" role="note" aria-label={t('Public only. Black Ops has no LAN launch flag and requires a verified firewall rule allowing inbound UDP from any address.')} title={t('Black Ops always launches public. A matching public inbound UDP firewall rule is required before Start.')}>{t('PUBLIC ONLY')}</span>;
  return <span className={`visibility-switch ${game.options.lan ? 'lan' : 'public'}`} role="group" aria-label={t('Saved server visibility for next start')}><span className="visibility-caption">{t('NEXT START')}</span>
    <button type="button" aria-pressed={game.options.lan} disabled={disabled} title={t('Saved for next start: LAN visibility. Does not change a running server or its firewall rule.')} onClick={() => onChange(true)}>{t('LAN')}</button>
    <button type="button" aria-pressed={!game.options.lan} disabled={disabled} title={t('Saved for next start: public visibility. Does not change a running server or its firewall rule; outside players also need UDP {port} forwarded on your router.', { port: game.options.port })} onClick={() => onChange(false)}>{t('Public')}</button>
  </span>;
}
function FirewallPanel({ game, status, busy, onApply, onRemove }: { game: Game; status: FirewallStatus | null; busy: boolean; onApply: () => void; onRemove: () => void }) {
  if (!status) return <p className="firewall-note">{t('Checking the Windows firewall rule…')}</p>;
  const titles: Record<string, string> = { missing: t('NO RULE'), lan: t('LAN-ONLY INBOUND'), any: t('PUBLIC INBOUND'), drift: t('MISMATCHED RULE'), unknown: t('STATUS UNKNOWN') };
  // BO1 always launches public, so its rule is open to any address (mirrors firewallScope).
  const lanRule = game.id !== 'bo1' && game.options.lan;
  const matchesVisibility = status.managed === true && status.state === (lanRule ? 'lan' : 'any');
  // While running, the rule follows the port the server was launched with.
  const pendingPort = game.activePort != null && game.activePort !== game.options.port;
  return <div>
    <div className="firewall-row">
      <span className={`fw-chip ${status.state}`}><ShieldCheck size={14} /> {titles[status.state]}</span>
      {(!matchesVisibility || status.legacy) && <button className="button outline-button firewall-apply" disabled={busy} title={t('Windows asks for administrator approval')} onClick={onApply}>{status.legacy ? t('Replace with botLANd rule') : status.state === 'missing' ? t('Create firewall rule') : status.state === 'unknown' ? t('Apply firewall rule') : t('Update firewall rule')}</button>}
      {/* Never offer to remove an unrelated or unmarked administrator rule. */}
      {status.managed && <button className="inline-link" disabled={busy || (game.id === 'bo1' && game.status !== 'stopped')} title={game.id === 'bo1' && game.status !== 'stopped' ? t('Stop BO1 before removing its required public firewall rule') : undefined} onClick={onRemove}>{t('Remove rule')} <ArrowRight size={13} /></button>}
    </div>
    {status.legacy && <p className="firewall-note">{t('This unmarked rule may have come from the old launcher scripts. Replace it with a verified botLANd rule before removing it; an unrelated or mismatched rule must be handled in Windows Firewall.')}</p>}
    {status.state === 'drift' && !status.legacy && !status.managed && <p className="firewall-note">{t('A different or ambiguous rule uses this name. botLANd will not remove it; inspect it in Windows Firewall before trying to create a managed rule.')}</p>}
    {status.state === 'unknown' && <p className="firewall-note">{t('The current rule could not be read. Use Refresh server status (top right) to check again, or apply the rule to replace it.')}</p>}
    <p className="firewall-hint">{t('Observed rule: {observed} on UDP {port}. Apply target: {scope} inbound UDP {applyPort} ({target}), based on saved visibility. Firewall changes apply immediately, even mid-match; they do not change the running server’s launch visibility. Windows asks for administrator approval.', { observed: status.state === 'lan' ? t('LAN-only inbound (local subnet)') : status.state === 'any' ? t('Public inbound (any address)') : titles[status.state].toLowerCase(), port: status.port, scope: lanRule ? t('LAN only') : t('Public'), applyPort: game.activePort ?? game.options.port, target: lanRule ? t('local subnet') : t('any address') })}{pendingPort ? ` ${t('The apply target uses the running server’s port; update it after the restart to move it to UDP {port}.', { port: game.options.port })}` : ''}{game.id === 'bo1' ? ` ${t('Black Ops always launches public and needs this rule to accept players beyond your LAN.')}` : ''}{lanRule ? ` ${t('LAN players connect to your PC’s local IP and need no router changes.')}` : ` ${t('Players beyond your home network also need UDP {port} opened or forwarded in your router settings — the firewall rule only covers this PC.', { port: status.port })}`}</p>
  </div>;
}
function ConnectPanel({ game, busy, onCopy }: { game: Game; busy: boolean; onCopy: (address: string) => void }) {
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  if (game.status !== 'running') return null;
  const candidates = game.connect.candidates;
  const selected = candidates.find(candidate => candidate.connectAddress === selectedAddress)
    || (!game.connect.ambiguous ? candidates.find(candidate => candidate.address === game.connect.primaryAddress || candidate.connectAddress === game.connect.primaryAddress) || (candidates.length === 1 ? candidates[0] : undefined) : undefined);
  return <section className="panel connect-panel"><div className="panel-heading compact"><div><span className="section-kicker">{t('JOIN THIS SERVER')}</span><h2 className="h3-style">{t('Connect address')}</h2></div><Radio size={18} /></div>
    {game.id === 'bo1' && <p className="setup-copy"><strong>{t('Black Ops 1:')}</strong> {t('The')} <code>connect</code> {t('console command does not work. Players must join through the in-game server browser.')}</p>}
    {game.connect.ambiguous && <p className="setup-copy">{t('More than one local network interface is available. Choose the address for the network your players use.')}</p>}
    {candidates.length > 1 && <label className="connect-choice" htmlFor={`connect-${game.id}`}>{t('Network interface')}<select id={`connect-${game.id}`} value={selected?.connectAddress || ''} onChange={event => setSelectedAddress(event.target.value || null)}><option value="">{t('Choose an interface')}</option>{candidates.map(candidate => <option key={`${candidate.adapter}-${candidate.connectAddress}`} value={candidate.connectAddress}>{candidate.label} · {candidate.address} ({candidate.scope})</option>)}</select></label>}
    <div className="connect-row"><code>{selected?.connectAddress || (!game.connect.ambiguous ? game.connect.primaryAddress : null) || (candidates.length ? t('Choose an interface above') : t('No address available'))}</code><button className="button outline-button" disabled={busy || !selected} onClick={() => { if (selected) onCopy(selected.connectAddress); }}><Copy size={14} /> {t('Copy')}</button></div>
    {selected && <p className="connect-scope">{selected.label} · {t('{scope} interface ({adapter})', { scope: selected.scope, adapter: selected.adapter })}</p>}
    <p className="connect-disclosure">{t('These are this PC’s interface addresses, not a verified internet/WAN address. Players outside your network may need router port forwarding; Public mode alone does not make a server reachable.')}</p>
  </section>;
}
function RestartPanel({ game, busy, now, onChange }: { game: Game; busy: boolean; now: number; onChange: (enabled: boolean) => void }) {
  if (!game.installed && game.status === 'stopped') return null;
  const seconds = game.restart.nextAttemptAt ? Math.max(0, Math.ceil((new Date(game.restart.nextAttemptAt).getTime() - now) / 1000)) : null;
  return <section className="panel restart-panel"><div className="panel-heading compact"><div><span className="section-kicker">{t('SERVER RECOVERY')}</span><h2 className="h3-style">{t('Automatic restart')}</h2></div></div>
    <label className="toggle-row"><span className={`toggle ${game.restart.enabled ? 'on' : ''}`}><input type="checkbox" aria-label={t('Restart {game} after an unexpected exit', { game: game.short })} checked={game.restart.enabled} disabled={busy} onChange={event => onChange(event.target.checked)} /><span /></span><span><strong>{t('Restart after an unexpected exit')}</strong><small>{game.restart.enabled ? t('On') : t('Off by default')} {t('· Manual Stop cancels pending retries.')}</small></span></label>
    {(game.status === 'restarting' || game.restart.cutOff || game.restart.attempts > 0) && <p className={`restart-state ${game.restart.cutOff ? 'restart-cutoff' : ''}`} role="status">{game.restart.cutOff ? t('Automatic restart stopped. Check the console for the reason, then start manually when ready.') : game.status === 'restarting' ? (seconds !== null ? t('Restart attempt {attempt} in {seconds}s. Use Stop server to cancel.', { attempt: game.restart.attempts, seconds }) : t('Restart attempt {attempt} pending. Use Stop server to cancel.', { attempt: game.restart.attempts })) : tp('{count} restart attempt this session.', '{count} restart attempts this session.', game.restart.attempts, { count: game.restart.attempts })}</p>}
  </section>;
}
function OrphanWarning({ game, busy, onRescan }: { game: Game; busy: boolean; onRescan: () => void }) {
  if (!game.orphan) return null;
  const pid = game.orphan.pid;
  return <div className="orphan-warning" role="status"><TriangleAlert size={18} /><div><strong>{t('Possible server process detected (not managed)')}</strong><p>{pid != null ? `PID ${pid}` : t('Unidentified process')} {t('· UDP')} {game.orphan.port}. {game.orphan.reason} {pid != null ? t('Inspect this PID in Windows Task Manager before starting another server.') : t('An ambiguous result means the owning process could not be identified; check Task Manager before starting another server.')} {t('botLANd cannot adopt or stop it.')}</p><button className="inline-link" disabled={busy} onClick={onRescan}><RefreshCw size={14} /> {t('Rescan processes')}</button></div></div>;
}
function keyUnavailableCopy(reason: Game['keyReason']) {
  if (reason === 'damaged') return t('The saved key file is damaged, so no keys can be read or saved. Reset key storage (the old file is kept, not deleted), then paste your key again.');
  if (reason === 'encryption-unavailable') return t('Windows encryption is not available for this user, so keys cannot be stored securely. Sign in with a normal Windows account and check Windows encryption. Keys are never stored in plain text.');
  return t('The saved key can no longer be read by this Windows profile. It was probably saved under a different account or profile. Paste your key again below to replace it.');
}
function KeyPanel({ game, draft, busy, saving, onDraft, onSave, onRemove, onReset, onKeyPage }: { game: Game; draft: string; busy: boolean; saving: boolean; onDraft: (value: string) => void; onSave: () => void; onRemove: () => void; onReset: () => void; onKeyPage: () => void }) {
  if (game.keyStatus === 'not-required') return null;
  const unavailable = game.keyStatus === 'unavailable';
  // The form must stay available for an unreadable key (pasting replaces it). It
  // is only hidden when saving cannot work until something else is fixed first.
  const canPaste = !unavailable || game.keyReason === 'unreadable' || !game.keyReason;
  const demo = document.documentElement.dataset.demo === 'true';
  const badge = game.keyStatus === 'stored' ? (demo ? t('DEMO KEY SET') : t('KEY STORED')) : !unavailable ? t('KEY MISSING') : game.keyReason === 'damaged' ? t('FILE DAMAGED') : game.keyReason === 'encryption-unavailable' ? 'UNAVAILABLE' : t('RE-ENTER KEY');
  return <section className="panel key-panel" id={`key-panel-${game.id}`}><div className="panel-heading compact"><div><span className="section-kicker">{t('PLUTONIUM ACCESS')}</span><h2 className="h3-style">{t('Server key')}</h2></div><span className={`key-state ${game.keyStatus}`}>{badge}</span></div>
    <p className="setup-copy">{demo ? t('Browser-only preview: key status is a temporary sample. No real server key is needed or saved.') : game.keyStatus === 'stored' ? t('A key is available for the next launch. Its value is never shown here.') : unavailable ? keyUnavailableCopy(game.keyReason) : t('A server key is needed before this Plutonium server can launch.')}</p>
    {game.keyReason === 'damaged' && <button className="button outline-button" disabled={busy} onClick={onReset}>{t('Reset key storage')}</button>}
    {canPaste && <form className="key-form" autoComplete="off" onSubmit={event => { event.preventDefault(); onSave(); }}><label htmlFor={`key-${game.id}`}>{t('Paste your own server key')}</label><div className="key-input-row"><input id={`key-${game.id}`} type="password" value={draft} onChange={event => onDraft(event.target.value)} autoComplete="off" spellCheck={false} placeholder={t('Paste key (hidden)')} disabled={busy} /><button className="button primary-button" type="submit" disabled={busy || !draft.trim()}>{saving ? t('Saving…') : game.keyStatus === 'stored' ? t('Replace key') : t('Save key')}</button></div></form>}
    <div className="key-actions"><button className="inline-link" disabled={busy} onClick={onKeyPage}>{t('Get a key from Plutonium')} <ExternalLink size={14} /></button>{game.keyStatus === 'stored' && <button className="inline-link" disabled={busy} onClick={onRemove}>{t('Remove saved key')} <X size={14} /></button>}</div>
    <p className="key-note">{demo ? t('Demo only: enter a placeholder, not a real key. The preview remembers only whether you entered one until this page reloads; it does not encrypt or persist keys.') : t('Create a key for {game} on the Plutonium website, copy it, then paste it above. It is encrypted with your Windows account and stored only on this PC.', { game: game.title })}</p>
    <p className="key-warning"><Info size={15} /> {demo ? t('This browser preview never launches a game or stores a key.') : t('The key is never displayed here, but the game still receives it on its process command line, where local process inspection may reveal it.')}</p>
  </section>;
}
type BotOperation = 'install' | 'update' | 'reinstall' | 'remove';
function BotPanel({ game, status, loading, error, busy, updateAvailable, onRetry, onAction, onChannel }: {
  game: Game; status: BotStatus | null; loading: boolean; error: string | null; busy: boolean; updateAvailable: boolean | null;
  onRetry: () => void; onAction: (operation: BotOperation) => void; onChannel: (channel: 'stable' | 'development') => void;
}) {
  const locked = busy || game.modBusy || game.engineBusy || game.status !== 'stopped' || !game.installed;
  const known = status?.state === 'installed';
  const unknown = status?.state === 'unknown';
  const developmentSupported = game.id === 'cod4' || game.id === 'bo2';
  return <section className="panel bot-panel"><div className="panel-heading compact"><div><span className="section-kicker">{t('MOD MANAGEMENT')}</span><h2 className="h3-style">{t('Bot Warfare')}</h2></div>{updateAvailable === true && <span className="bot-update-badge">{t('UPDATE AVAILABLE')}</span>}</div>
    {!game.installed ? <p className="setup-copy">{t('Choose a game folder before managing Bot Warfare.')}</p> : loading ? <p className="setup-copy" role="status">{t('Reading local Bot Warfare status…')}</p> : error ? <div className="bot-status-note" role="status"><Info size={16} /><span>{error} {t('Your server controls remain available.')}</span><button className="inline-link" disabled={busy} onClick={onRetry}>{t('Retry')}</button></div> : status && <>
      <div className="bot-state-row"><strong>{known ? t('Managed installation') : unknown ? t('Existing files (unmanaged)') : t('Not installed')}</strong>{game.modBusy && <span>{t('Mod operation in progress…')}</span>}</div>
      <p className="bot-path" title={status.targetPath}>{status.targetPath}</p>
      {known && status.manifest && <dl className="bot-facts"><div><dt>{t('Version')}</dt><dd>{status.manifest.ref} <small>({status.manifest.channel}, {status.manifest.refType})</small></dd></div><div><dt>{t('Source')}</dt><dd>{status.manifest.repo}</dd></div><div><dt>{t('SHA-256')}</dt><dd title={status.manifest.sha256}>{status.manifest.sha256}</dd></div><div><dt>{t('Installed')}</dt><dd>{formatDate(status.manifest.date)}</dd></div></dl>}
      {unknown && <p className="bot-caution"><TriangleAlert size={16} /> {t('Files already exist but their version is unknown. Installing replaces them with the latest Bot Warfare. The old files are not kept.')}</p>}
      <div className="bot-source"><strong>{t('Upstream')} {status.source.ref || t('version unavailable')}</strong><span>{updateStatus(status.source.status)}</span>{status.source.notes && <p>{status.source.notes}</p>}</div>
      <div className="bot-actions">
        {(status.state === 'not-installed' || unknown) && <button className="button primary-button" disabled={locked || !status.source.supported} onClick={() => onAction('install')}>{t('Install Bot Warfare')}</button>}
        {known && <button className="button primary-button" disabled={locked || !status.source.supported || updateAvailable !== true} title={updateAvailable === null ? t('No update information yet. Use Check now on the Dashboard.') : updateAvailable === false ? t('Already up to date.') : undefined} onClick={() => onAction('update')}>{t('Update')}</button>}
        {known && <button className="button outline-button" disabled={locked || !status.source.supported} onClick={() => onAction('reinstall')}>{t('Reinstall')}</button>}
        {known && <button className="button outline-button" disabled={locked} onClick={() => onAction('remove')}>{t('Remove')}</button>}
      </div>
      {locked && <p className="bot-locked-reason" role="status">{!game.installed ? t('Choose a game folder before changing Bot Warfare files.') : game.status !== 'stopped' ? t('Stop the server before changing Bot Warfare files.') : game.modBusy || game.engineBusy || busy ? t('Wait for the current file change to finish.') : t('Wait for the current action to finish.')}</p>}
      <details className="bot-advanced"><summary>{t('Advanced: release channel')}</summary><p>{t('Stable releases are recommended. Development builds may be untested and are an explicit opt-in.')}</p>{developmentSupported ? <div className="bot-channel"><button type="button" aria-pressed={status.channel === 'stable'} disabled={locked} onClick={() => onChannel('stable')}>{t('Stable')}</button><button type="button" aria-pressed={status.channel === 'development'} disabled={locked} onClick={() => onChannel('development')}>{t('Development')}</button></div> : <p>{t('Development builds are not supported for this game; stable releases only.')}</p>}</details>
      <p className="bot-disclaimer">{t('Only changes this game\'s Bot Warfare files. No mod is downloaded or installed automatically. Stop the server before making changes.')}</p>
    </>}
  </section>;
}
// One row per setup step. Engine setup points at the shared bottom-left
// sidebar controls; other unfinished steps carry their own action buttons.
interface SetupStep { key: string; title: string; done: boolean; detail: string; optional?: boolean; action?: { label: string; run: () => void; disabled?: boolean; icon?: typeof Activity }; secondary?: { label: string; run: () => void; disabled?: boolean } }
function SetupChecklist({ steps, ready, blockers, start }: { steps: SetupStep[]; ready: boolean; blockers: string[]; start: ReactNode }) {
  const next = steps.find(step => !step.done && !step.optional)?.key;
  const required = steps.filter(step => !step.optional);
  const doneCount = required.filter(step => step.done).length;
  // Every checklist step can be green while a preflight blocker still refuses
  // Start (MW3 runtime files, an interrupted engine update). Say so instead of
  // claiming the checklist is finished.
  const blocked = !ready && required.every(step => step.done);
  // A finished checklist collapses to what still matters: open steps and Start.
  const [expanded, setExpanded] = useState(false);
  const collapsed = ready && !expanded;
  return <section className="panel setup-wizard" aria-label={t('Setup checklist')}>
    <div className="panel-heading"><div className="panel-icon"><Gamepad2 size={19} /></div><div><span className="section-kicker">{ready ? t('ALL SET') : t('GETTING STARTED')}</span><h2>{t('Setup checklist')}</h2></div><span className={`readiness-pill ${ready ? 'good' : 'bad'}`}>{blocked ? t('CHECK REQUIRED') : t('{done} / {total} DONE', { done: doneCount, total: required.length })}</span></div>
    {ready && <button className="inline-link setup-toggle" aria-expanded={expanded} onClick={() => setExpanded(previous => !previous)}>{expanded ? t('Hide completed steps') : t('Show completed steps ({count})', { count: steps.filter(step => step.done).length })}</button>}
    <ol className="setup-steps">{steps.map((step, index) => collapsed && step.done ? null : (() => {
      const Icon = step.action?.icon;
      return <li key={step.key} className={`setup-step ${step.done ? 'done' : ''} ${step.key === next ? 'current' : ''} ${step.optional ? 'optional' : ''}`}>
        <span className="setup-step-mark" aria-hidden="true">{step.done ? <Check size={15} /> : index + 1}</span>
        <div className="setup-step-body"><strong>{step.title}{step.optional && <small> {t('· recommended')}</small>}<span className="sr-only">{step.done ? t(' (done)') : t(' (to do)')}</span></strong><p>{step.detail}</p></div>
        <div className="setup-step-actions">
          {step.secondary && <button className="inline-link" disabled={step.secondary.disabled} onClick={step.secondary.run}>{step.secondary.label}</button>}
          {step.action && <button className={`button ${step.key === next ? 'primary-button' : 'outline-button'}`} disabled={step.action.disabled} onClick={step.action.run}>{Icon && <Icon size={15} />} {step.action.label}</button>}
        </div>
      </li>;
    })())}
      <li className={`setup-step final ${ready ? 'current' : ''}`}><span className="setup-step-mark" aria-hidden="true"><Play size={14} fill="currentColor" /></span><div className="setup-step-body"><strong>{ready ? t('Ready to start') : blocked ? t('One check still blocks Start') : t('Start your server')}</strong><p>{ready ? t('Everything is in place. Settings and maps can still be changed at any time; they apply on the next start.') : blocked ? (blockers[0] || t('Resolve the highlighted check above to unlock Start.')) : t('Finish the steps above to unlock Start.')}</p></div><div className="setup-step-actions">{start}</div></li>
    </ol>
  </section>;
}
function Logo() { return <div className="brand-symbol"><span /><span /><span /></div>; }

function ConsolePanel({ game }: { game: Game }) {
  const [paused, setPaused] = useState(false);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const pausedLines = useRef<LogEntry[]>([]);
  const scroller = useRef<HTMLDivElement | null>(null);
  const follow = useRef(true);
  const lines = paused ? pausedLines.current : game.logs;
  const term = query.trim().toLowerCase();
  const visible = term ? lines.filter(line => line.message.toLowerCase().includes(term) || (line.source || 'manager').toLowerCase().includes(term)) : lines;
  const keys = logKeys(visible);
  const newLines = paused ? Math.max(0, game.logs.length - pausedLines.current.length) : 0;
  // Keep the console on the newest output unless the user scrolled up or paused.
  useEffect(() => {
    const element = scroller.current;
    if (element && follow.current && !paused && !term) element.scrollTop = element.scrollHeight;
  }, [game.logs, paused, term]);
  useEffect(() => { setPaused(false); setQuery(''); setCopied(false); follow.current = true; }, [game.id]);
  const togglePause = () => {
    if (!paused) pausedLines.current = [...game.logs];
    setPaused(!paused);
    follow.current = true;
  };
  const jumpToLatest = () => {
    follow.current = true;
    setPaused(false);
    setQuery('');
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  };
  const copyVisible = async () => {
    const text = visible.map(line => `${gameTime(line.at)} ${line.source || 'manager'} ${line.message}`).join('\n');
    try { await window.manager.copyText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); }
  };
  return <section className="panel console-panel" role="tabpanel" id="panel-console" aria-labelledby="tab-console">
    <div className="panel-heading"><div className="panel-icon"><Terminal size={19} /></div><div><span className="section-kicker">{t('LIVE FEED')}</span><h2>{t('Server console')}</h2></div><span className="console-state"><span className={game.status === 'running' ? 'online' : (game.status === 'starting' || game.status === 'stopping' || game.status === 'restarting') ? 'attention' : ''} />{game.status === 'running' ? `PID ${game.pid}` : game.status === 'starting' ? 'STARTING' : game.status === 'stopping' ? 'STOPPING' : game.status === 'restarting' ? 'RESTARTING' : 'OFFLINE'}</span></div>
    <div className="console-window">
      <div className="console-toolbar"><span className="terminal-dots"><i /><i /><i /></span><span>{game.engine.toLowerCase().replaceAll(' ', '-')} {t('/ output')}</span><span className="terminal-live">{game.status === 'running' ? t('● LIVE') : game.status === 'starting' ? t('● STARTING') : game.status === 'stopping' ? t('● STOPPING') : game.status === 'restarting' ? t('● RESTARTING') : t('● IDLE')}</span></div>
      <div className="console-actions">
        <label className="console-search"><Search size={14} aria-hidden="true" /><span className="sr-only">{t('Filter server output')}</span><input type="search" placeholder={t('Filter output…')} value={query} onChange={event => setQuery(event.target.value)} /></label>
        <button className="outline-button" onClick={togglePause}>{paused ? newLines ? t('Resume ({count} new)', { count: newLines }) : t('Resume') : t('Pause')}</button>
        <button className="outline-button" onClick={jumpToLatest} disabled={!paused && !term && follow.current}>{t('Jump to latest')}</button>
        <button className="outline-button" onClick={copyVisible} disabled={!visible.length}>{copied ? t('Copied') : t('Copy')}</button>
        <button className="outline-button" onClick={() => { window.manager.openLogs().catch(() => {}); }}>{t('Open logs')}</button>
      </div>
      <div className="console-lines" role="log" aria-label={t('Server output')} aria-live={paused ? 'polite' : 'off'} tabIndex={0} ref={scroller} onScroll={event => { const element = event.currentTarget; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40; }}>
        {visible.length ? visible.map((line: LogEntry, index) => <div className={`console-line ${line.level === 'error' ? 'error' : ''}`} key={keys[index]}><time>{gameTime(line.at)}</time><span className={`console-source ${line.source || 'manager'}`}>{line.source || 'manager'}</span>{line.level === 'error' && <span className="console-level">{t('ERROR')}</span>}<span>{line.message || ' '}</span></div>)
          : <div className="console-placeholder"><Terminal size={35} /><strong>{term ? t('No lines match.') : t('Nothing on the wire yet.')}</strong><span>{term ? t('Clear the filter to see all output.') : game.status === 'stopped' ? t('Start this server to see its output here.') : t('Waiting for the server to print its first lines…')}</span></div>}
      </div>
    </div>
    {paused && <div className="console-paused" role="status">{tp('Paused. {count} new line buffered; Resume or Jump to latest to continue.', 'Paused. {count} new lines buffered; Resume or Jump to latest to continue.', newLines, { count: newLines })}</div>}
    <div className="console-footnote"><Info size={16} /> {document.documentElement.dataset.demo === 'true' ? t('Browser preview: output is simulated and no log file is written.') : t('Recent output is shown here; session logs are also saved to disk in botLANd’s app data folder. Keys are redacted, but other server output may be sensitive - review logs before sharing.')}</div>
  </section>;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const locale = useLocale();
  const [selectedId, setSelectedId] = useState<GameId | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [mapCache, setMapCache] = useState<Partial<Record<GameId, MapData & { gamePath: string }>>>({});
  const [artRevision, setArtRevision] = useState<Partial<Record<GameId, number>>>({});
  // `${id}:${kind}` is true once the image has decoded; the decorative
  // fallback stays until then and returns if the file is missing.
  const [artReady, setArtReady] = useState<Record<string, boolean>>({});
  const [mapLoading, setMapLoading] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapSearch, setMapSearch] = useState('');
  const [mapSelection, setMapSelection] = useState<string[]>([]);
  const [portDraft, setPortDraft] = useState('');
  const [modeDraft, setModeDraft] = useState('');
  const [shuffleDraft, setShuffleDraft] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [busyTick, setBusyTick] = useState(0);
  // Log lines arrive one IPC event per line; coalesce them into one render.
  const pendingLogs = useRef<Partial<Record<GameId, LogEntry[]>>>({});
  const logFlush = useRef<number | null>(null);
  const busySince = useRef(0);
  // Stop requests are tracked per game, independent of the global busy flag.
  const [stopRequests, setStopRequests] = useState<GameId[]>([]);
  const stopLocks = useRef(new Set<GameId>());
  const [configDirty, setConfigDirty] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);
  const rotationDraft = useRef<{ id: GameId | null; path: string; dirty: boolean }>({ id: null, path: '', dirty: false });
  const lastMapScan = useRef<{ id: GameId; path: string; maps: string[] } | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [firewallStatus, setFirewallStatus] = useState<FirewallStatus | null>(null);
  const [bo1DashboardFirewall, setBo1DashboardFirewall] = useState<FirewallStatus | null>(null);
  // `scope` ties a message to the page it came from (a game id, or null for the
  // Dashboard), so a slow action never reports on another game's page.
  const [notice, setNotice] = useState<{ text: string; error: boolean; scope?: GameId | null } | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [botState, setBotState] = useState<{ id: GameId; path: string; status: BotStatus | null; error: string | null; loading: boolean } | null>(null);
  const [botRevision, setBotRevision] = useState(0);
  const [clock, setClock] = useState(Date.now());
  // `busy` state updates asynchronously; this ref blocks a second click in the same tick.
  const busyLock = useRef(false);
  const mainPane = useRef<HTMLElement | null>(null);
  const focusAfterNavigation = useRef(false);
  const snapshotVersion = useRef(0);
  const snapshotRequest = useRef(0);
  // The game page currently open, readable from async callbacks that outlive a render.
  const selectedRef = useRef<GameId | null>(null);
  useEffect(() => { selectedRef.current = selectedId; }, [selectedId]);
  useEffect(() => { setLocale(snapshot?.locale || 'en'); }, [snapshot?.locale]);

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
      else if (event.type === 'log') {
        // One event per line would re-render the whole app per line; coalesce.
        (pendingLogs.current[event.id] ||= []).push(event.entry);
        if (logFlush.current === null) {
          logFlush.current = window.setTimeout(() => {
            logFlush.current = null;
            const batch = pendingLogs.current;
            pendingLogs.current = {};
            setSnapshot(previous => previous ? {
              ...previous,
              games: previous.games.map(game => batch[game.id] ? { ...game, logs: [...game.logs, ...batch[game.id]!].slice(-120) } : game),
            } : previous);
          }, 80);
        }
      }
    });
    return () => { active = false; unsubscribe(); if (logFlush.current !== null) { window.clearTimeout(logFlush.current); logFlush.current = null; } pendingLogs.current = {}; };
  }, []);

  const game = snapshot?.games.find(entry => entry.id === selectedId);
  const artKey = (id: GameId, kind: ArtworkKind) => `${id}:${kind}`;
  const artReadyFor = (id: GameId, kind: ArtworkKind) => artReady[artKey(id, kind)] === true;
  const artUrlFor = (id: GameId, kind: ArtworkKind, gamePath: string) => artworkUrl(id, kind, artworkVersion(gamePath, artRevision[id] || 0));
  const markArt = (id: GameId, kind: ArtworkKind, ready: boolean) => setArtReady(previous => previous[artKey(id, kind)] === ready ? previous : { ...previous, [artKey(id, kind)]: ready });
  const bumpArtwork = (id: GameId, kind: ArtworkKind) => {
    setArtRevision(previous => ({ ...previous, [id]: (previous[id] || 0) + 1 }));
    markArt(id, kind, false);
  };
  useEffect(() => {
    const label = tabs.find(item => item.id === tab)?.label || 'Overview';
    document.title = selectedId ? t('{game} — {section} · botLANd', { game: game?.short || selectedId, section: label }) : t('botLANd Server Manager');
  }, [selectedId, tab, game?.short, locale]);
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => setBusyTick(tick => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    if (focusAfterNavigation.current) {
      focusAfterNavigation.current = false;
      mainPane.current?.focus();
    }
  }, [selectedId, tab]);
  // Preserve an unsaved editor when its installation temporarily disappears.
  // The user can explicitly discard it, or wait for the folder to return.
  useEffect(() => {
    if (!game || tab === 'overview' || game.installed) return;
    if (tab === 'console' && game.status !== 'stopped') return;
    if (tab === 'configuration' && (configDirty || configBusy)) return;
    if (tab === 'rotation' && rotationDraft.current.id === game.id && rotationDraft.current.dirty) return;
    setTab('overview');
  }, [game?.installed, game?.status, game?.id, tab, configDirty, configBusy]);
  useEffect(() => {
    if (game?.status !== 'restarting' || !game.restart.nextAttemptAt) return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [game?.status, game?.restart.nextAttemptAt]);
  const currentBotState = game && botState?.id === game.id && botState.path === game.gamePath ? botState : null;
  const maps = selectedId && game?.installed && mapCache[selectedId]?.gamePath === game.gamePath ? mapCache[selectedId] : undefined;
  useEffect(() => {
    if (!game || rotationDraft.current.dirty) return;
    rotationDraft.current.path = game.gamePath;
    setPortDraft(String(game.options.port));
    setModeDraft(game.options.mode);
    setShuffleDraft(game.options.shuffle);
  }, [selectedId, game?.gamePath, game?.options.port, game?.options.mode, game?.options.shuffle]);
  useEffect(() => {
    // A scan abandoned by switching games never reaches its own `finally`, so clear the flag here.
    if (!selectedId || !game?.installed || !game.gamePath) { setMapLoading(false); return; }
    let active = true;
    setMapLoading(true);
    setMapError(null);
    // A failed refresh must not leave an old map list available for saving.
    setMapCache(previous => { const next = { ...previous }; delete next[selectedId]; return next; });
    window.manager.maps(selectedId).then(data => {
      if (!active) return;
      setMapCache(previous => ({ ...previous, [selectedId]: { ...data, gamePath: game.gamePath } }));
      const previousScan = lastMapScan.current;
      lastMapScan.current = { id: selectedId, path: game.gamePath, maps: data.maps };
      // Preserve edits on rescan. If the draft included every previously installed
      // map, extend that intention to newly discovered maps (including a port-only
      // edit); otherwise leave the user's explicit subset untouched.
      if (rotationDraft.current.id === selectedId && rotationDraft.current.dirty) {
        if (rotationDraft.current.path === game.gamePath && previousScan?.id === selectedId && previousScan.path === game.gamePath && previousScan.maps.length) {
          setMapSelection(previous => previousScan.maps.every(map => previous.includes(map)) ? data.maps : previous);
        }
      } else {
        setMapSelection(game.options.selectedMaps.length ? game.options.selectedMaps.filter(map => data.maps.includes(map)) : data.maps);
        setModeDraft(data.modes.some(option => option.value === game.options.mode) ? game.options.mode : (data.modes[0]?.value || ''));
      }
    }).catch(error => {
      if (!active) return;
      setMapError(displayError(error));
      setNotice({ text: t('Map scan failed: {message}', { message: displayError(error) }), error: true, scope: selectedId });
    }).finally(() => { if (active) setMapLoading(false); });
    return () => { active = false; };
  }, [selectedId, game?.installed, game?.gamePath, refreshRevision]);

  const firewallChanging = busy === 'fw-apply' || busy === 'fw-remove';
  useEffect(() => {
    // Invalidate reads on both sides of an elevated mutation, including reads
    // started by navigation while its administrator prompt is still pending.
    if (firewallChanging || !selectedId || !game?.installed) { setFirewallStatus(null); return; }
    let active = true;
    setFirewallStatus(null);
    window.manager.firewallStatus(selectedId)
      .then(status => { if (active) setFirewallStatus(status); })
      .catch(() => { if (active) setFirewallStatus({ name: '', port: game?.activePort ?? game?.options.port ?? 0, state: 'unknown' }); });
    return () => { active = false; };
  }, [selectedId, game?.installed, game?.gamePath, game?.options.port, game?.activePort, refreshRevision, firewallChanging]);
  // The firewall step is optional for LAN in the checklist, but without a
  // matching rule Windows can silently block other PCs. Readiness must not say
  // "Everything looks good" in that state.
  const wantedFirewall = game ? (game.id === 'bo1' || !game.options.lan ? 'any' : 'lan') : null;
  const firewallAdvisory = Boolean(game?.installed && firewallStatus && firewallStatus.state !== wantedFirewall);
  const bo1OnDashboard = snapshot?.games.find(entry => entry.id === 'bo1');  // The sidebar lists BO1 on every page, not just on the Dashboard. Keep its
  // verified rule status available while managing a different game too.
  useEffect(() => {
    if (firewallChanging || selectedId === 'bo1' || !bo1OnDashboard?.installed) { setBo1DashboardFirewall(null); return; }
    let active = true;
    setBo1DashboardFirewall(null);
    window.manager.firewallStatus('bo1').then(status => { if (active) setBo1DashboardFirewall(status); })
      .catch(() => { if (active) setBo1DashboardFirewall({ name: '', port: bo1OnDashboard.options.port, state: 'unknown' }); });
    return () => { active = false; };
  }, [selectedId, bo1OnDashboard?.installed, bo1OnDashboard?.gamePath, bo1OnDashboard?.options.port, bo1OnDashboard?.activePort, refreshRevision, firewallChanging]);

  useEffect(() => {
    if (!selectedId || !game?.installed || !game.gamePath) { setBotState(null); return; }
    let active = true;
    const id = selectedId;
    const path = game.gamePath;
    setBotState({ id, path, status: null, error: null, loading: true });
    window.manager.botStatus(id).then(status => { if (active) setBotState({ id, path, status, error: null, loading: false }); })
      .catch(error => { if (active) setBotState({ id, path, status: null, error: t('Bot Warfare status could not be read: {message}', { message: displayError(error) }), loading: false }); });
    return () => { active = false; };
  }, [selectedId, game?.installed, game?.gamePath, refreshRevision, botRevision]);

  const currentBo1Firewall = selectedId === 'bo1' ? firewallStatus : bo1DashboardFirewall;
  const bo1RuleReady = currentBo1Firewall?.state === 'any' && currentBo1Firewall.managed === true;
  const firewallFor = (entry: Game) => entry.id === 'bo1' ? currentBo1Firewall : null;
  const detectedGames = snapshot?.games.filter(entry => entry.installed) || [];
  // An installation can disappear while its server keeps running. Keep those
  // games visible so their Stop control never disappears from the UI.
  const activeUnavailableGames = snapshot?.games.filter(entry => !entry.installed && entry.status !== 'stopped') || [];
  const dashboardGames = snapshot?.games.filter(entry => entry.installed || entry.status !== 'stopped') || [];
  const missingGames = snapshot?.games.filter(entry => !entry.installed && entry.status === 'stopped') || [];
  const running = snapshot?.games.filter(entry => entry.status === 'running').length || 0;
  const plutoniumRunning = !!snapshot?.games.some(entry => entry.setup.plutonium !== null && entry.status !== 'stopped' && entry.status !== 'restarting');
  const ready = detectedGames.filter(entry => !entry.blockers.length && !entry.engineBusy && entry.status === 'stopped' && (entry.id !== 'bo1' || bo1RuleReady)).length;
  const visibleMaps = useMemo(() => maps?.maps.filter(map => map.includes(mapSearch.trim().toLowerCase()) || gameMapName(map).toLowerCase().includes(mapSearch.trim().toLowerCase())) || [], [maps, mapSearch]);
  const savedMaps = game && maps ? (game.options.selectedMaps.length ? game.options.selectedMaps.filter(name => maps.maps.includes(name)) : maps.maps) : [];
  const missingMaps = game && maps ? game.options.selectedMaps.filter(name => !maps.maps.includes(name)) : [];
  const missingDraftMaps = maps ? mapSelection.filter(name => !maps.maps.includes(name)) : [];
  const missingMode = !!game && !!maps && !maps.modes.some(option => option.value === game.options.mode);
  const savedMode = game ? (missingMode ? maps?.modes[0]?.value || game.options.mode : game.options.mode) : '';
  const rotationDirty = !!game && !!maps && !mapLoading && (portDraft !== String(game.options.port) || modeDraft !== savedMode || shuffleDraft !== game.options.shuffle || mapSelection.length !== savedMaps.length || mapSelection.some(name => !savedMaps.includes(name)));
  if (rotationDraft.current.id !== selectedId) rotationDraft.current = { id: selectedId, path: game?.gamePath || '', dirty: false };
  const rotationPathConflict = !!game && rotationDraft.current.dirty && rotationDraft.current.path !== game.gamePath;
  if (game?.installed && maps && !mapLoading && !rotationPathConflict) rotationDraft.current.dirty = rotationDirty;
  const rotationPending = tab === 'rotation' && rotationDraft.current.dirty;
  const unsavedDraft = (tab === 'configuration' && configDirty) || rotationPending;
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
  // Lets the quit prompt mention unsaved drafts before any server is stopped.
  useEffect(() => { window.manager.setUnsavedChanges(unsavedDraft).catch(() => {}); }, [unsavedDraft]);
  // Validate before saving: an empty or non-numeric draft must not reach the
  // backend as Number('') === 0 or NaN.
  const portText = portDraft.trim();
  const portValid = /^\d+$/.test(portText) && Number(portText) >= 1024 && Number(portText) <= 65535;
  function resetRotationDrafts() {
    if (!game) return;
    setPortDraft(String(game.options.port));
    setModeDraft(savedMode);
    setShuffleDraft(game.options.shuffle);
    setMapSelection(savedMaps);
    rotationDraft.current = { id: game.id, path: game.gamePath, dirty: false };
  }
  function canLeave() {
    if (tab === 'rotation' && busy === 'rotation') { setNotice({ text: t('Wait for launch options to finish saving before leaving. Stop and Cancel start remain available.'), error: true }); return false; }
    if (tab === 'configuration' && configBusy) { setNotice({ text: t('Finish or close the configuration review before leaving.'), error: true }); return false; }
    if ((tab === 'configuration' && configDirty) || rotationPending) {
      if (!window.confirm(t('Discard unsaved changes?'))) return false;
      if (tab === 'rotation') resetRotationDrafts();
    }
    return true;
  }
  // Focus stays on the activated tab so keyboard users keep their place.
  function selectTab(next: Tab) { if (next !== tab && canLeave()) { setKeyDraft(''); setTab(next); } }
  function goHome() { if (canLeave()) { if (selectedId !== null) focusAfterNavigation.current = true; setKeyDraft(''); setSelectedId(null); setTab('overview'); } }
  // Rescans installations too (which includes the process scan), so a newly
  // installed or moved game is always reachable from the top bar.
  function refreshWorkspace() {
    if (busy || !canLeave()) return;
    setRefreshRevision(previous => previous + 1);
    action('refresh', () => window.manager.rescanInstallations());
  }
  async function syncSnapshot() {
    const version = snapshotVersion.current;
    const request = ++snapshotRequest.current;
    const data = await window.manager.snapshot();
    if (version === snapshotVersion.current && request === snapshotRequest.current) setSnapshot(data);
  }
  // A completed write must not be reported as a failed write merely because the
  // follow-up status read failed. The mutation and the refresh are separate steps.
  async function syncAfterAction(success?: string, scope: GameId | null = selectedRef.current) {
    try {
      await syncSnapshot();
      if (success) setNotice({ text: success, error: false, scope });
    } catch (error) {
      const text = t('Action completed, but the status could not be refreshed: {message}. Use Refresh server status to try again.', { message: displayError(error) });
      setNotice({ text: success ? `${success} ${text}` : text, error: true, scope });
    }
  }
  async function action(label: string, task: () => Promise<unknown>, success?: string) {
    if (busy || busyLock.current) return;
    busyLock.current = true;
    const scope = selectedRef.current;
    setBusy(label); setBusyTick(0); busySince.current = Date.now(); setNotice(null);
    try {
      await task();
      await syncAfterAction(success, scope);
    } catch (error) {
      const text = displayError(error);
      const cancelled = label.startsWith('start-') && /Launch cancelled/i.test(text);
      setNotice({ text: cancelled ? t('Server launch cancelled.') : text, error: !cancelled, scope });
    } finally { busyLock.current = false; setBusy(null); }
  }
  function openGame(id: GameId) { if (!canLeave()) return; if (id !== selectedId || tab !== 'overview') focusAfterNavigation.current = true; setKeyDraft(''); setSelectedId(id); setTab('overview'); setMapSearch(''); setNotice(null); }
  // Never surface arbitrary key-related IPC errors: an underlying error could contain private
  // input. Only the fixed messages in knownKeyErrors are shown. Resolves true when the task succeeded.
  async function keyAction(label: string, task: () => Promise<void>, success: string) {
    if (busy || busyLock.current) return false;
    busyLock.current = true;
    const scope = selectedRef.current;
    setBusy(label); setBusyTick(0); busySince.current = Date.now(); setNotice(null);
    try {
      await task();
      try { await syncSnapshot(); setNotice({ text: success, error: false, scope }); }
      catch { setNotice({ text: t('Key action completed, but the key status could not be refreshed. Reopen this game to check it.'), error: true, scope }); }
      return true;
    } catch (error) {
      const shown = displayError(error);
      const known = knownKeyErrors.find(message => shown === message);
      setNotice({ text: known ? t('Key action failed: {message}', { message: translate(known) }) : t('Key action failed. Check that the key service is available and try again.'), error: true, scope });
    }
    finally { busyLock.current = false; setBusy(null); }
    return false;
  }
  function resetKeyStorage() {
    if (!window.confirm(t('Set the damaged key file aside? It is renamed (not deleted) and you will need to paste your server keys again.'))) return;
    keyAction('key-reset', async () => {
      if (!await window.manager.resetKeyStore()) throw new Error('Key storage was not damaged, so nothing was changed.');
    }, t('Key storage was reset. Paste your server key again.'));
  }
  function savePastedKey(id: GameId) {
    const submitted = keyDraft.trim();
    if (!submitted || busy || busyLock.current) return;
    setKeyDraft('');
    // A failed save puts the pasted key back so it does not need to be copied again.
    keyAction('key-save', () => window.manager.saveKey(id, submitted), document.documentElement.dataset.demo === 'true' ? t('Demo key status set in memory only. No key was stored or encrypted.') : t('Server key saved. The paste field has been cleared.'))
      .then(saved => { if (!saved && selectedRef.current === id) setKeyDraft(current => current || submitted); });
  }
  async function changeArtwork(id: GameId, kind: Exclude<ArtworkKind, 'logo'>) {
    if (busy || busyLock.current) return;
    busyLock.current = true;
    setBusy('artwork'); setNotice(null);
    try {
      if (await window.manager.chooseArtwork(id, kind)) {
        bumpArtwork(id, kind);
        setNotice({ text: t('Custom {kind} image selected. The image stays on this computer.', { kind: kind === 'hero' ? t('header') : t('card') }), error: false, scope: id });
      }
    } catch (error) { setNotice({ text: displayError(error), error: true, scope: id }); }
    finally { busyLock.current = false; setBusy(null); }
  }
  // Reset one kind at a time: clearing the header must not silently discard a chosen cover.
  async function restoreArtwork(id: GameId, kind: Exclude<ArtworkKind, 'logo'>) {
    if (busy || busyLock.current) return;
    const label = kind === 'hero' ? 'header' : 'card';
    if (!window.confirm(t('Use the Steam {kind} image? A custom {kind} you chose earlier will be forgotten (the image file itself is not deleted).', { kind: translate(label) }))) return;
    busyLock.current = true;
    setBusy('artwork'); setNotice(null);
    try {
      await window.manager.resetArtwork(id, kind);
      bumpArtwork(id, kind);
      setNotice({ text: t('Using locally cached Steam {kind} artwork where available.', { kind: translate(label) }), error: false, scope: id });
    } catch (error) { setNotice({ text: displayError(error), error: true, scope: id }); }
    finally { busyLock.current = false; setBusy(null); }
  }
  function saveRotation() {
    if (!game || !maps || mapLoading || mapError || rotationPathConflict || busyLock.current) return;
    if (missingDraftMaps.length) return setNotice({ text: t('Some selected maps are no longer installed. Remove them from the draft before saving.'), error: true });
    if (!portValid) return setNotice({ text: t('UDP port must be a whole number between 1024 and 65535.'), error: true });
    if (mapSelection.length < (game.id === 'bo2' ? 2 : 1)) return setNotice({ text: game.id === 'bo2' ? t('Black Ops II needs at least two maps.') : t('Choose at least one map for the rotation.'), error: true });
    const orderedSelection = maps?.maps.filter(map => mapSelection.includes(map)) || mapSelection;
    // An empty list means "every installed map", so maps installed later join the rotation too.
    const everyMap = !!maps && maps.maps.length > 0 && maps.maps.every(map => mapSelection.includes(map));
    action('rotation', () => window.manager.saveOptions(game.id, { port: Number(portText), mode: modeDraft, shuffle: shuffleDraft, selectedMaps: everyMap ? [] : orderedSelection }), t('Launch options saved. Rotation will be generated on the next start.'));
  }
  function toggleMap(name: string) { setMapSelection(previous => previous.includes(name) ? previous.filter(map => map !== name) : [...previous, name]); }
  function changeVisibility(target: Game, next: boolean) {
    if (target.options.lan === next) return;
    const live = target.status === 'running' || target.status === 'starting';
    const router = next ? '' : ` ${t('Players joining from outside your network also need UDP {port} opened on your router.', { port: target.options.port })}`;
    action('visibility', () => window.manager.saveOptions(target.id, { lan: next }),
      t('{scope} visibility saved. {effect}{router}', { scope: next ? t('LAN') : t('Public'), effect: live ? t('The running server keeps its current visibility until restarted.') : t('Takes effect at the next start.'), router }));
  }
  async function changeFirewall(target: Game, apply: boolean) {
    if (!apply && !window.confirm(target.id === 'bo1'
      ? t('Removing the required Black Ops public firewall rule can prevent outside players from connecting. You will need to create it again before the next Start. Continue?')
      : t('Remove the botLANd firewall rule for {game}? This applies immediately, even mid-match.', { game: target.short }))) return;
    await action(apply ? 'fw-apply' : 'fw-remove', async () => {
      // Do not publish a completion into a page/cache that may have changed
      // during elevation. Both status effects re-read after this action settles,
      // even on failure (a timed-out prompt may still have changed the rule).
      if (apply) await window.manager.firewallApply(target.id);
      else await window.manager.firewallRemove(target.id);
    }, apply ? t('Firewall rule updated for UDP {port}.', { port: target.activePort ?? target.options.port }) : t('The botLANd firewall rule was removed.'));
  }
  function manageBot(target: Game, operation: BotOperation) {
    if (busy || busyLock.current || target.modBusy || target.status !== 'stopped' || !target.installed) return;
    const prompts: Partial<Record<BotOperation, string>> = {
      reinstall: t('Reinstall the latest Bot Warfare for {game}? Every Bot Warfare file, including any you edited such as waypoints, is overwritten. The old files are not kept.', { game: target.short }),
      remove: t('Remove Bot Warfare from {game}? This deletes managed mod files. Back up any custom changes first.', { game: target.short }),
    };
    if (operation === 'install' && currentBotState?.status?.state === 'unknown' && !window.confirm(t('Bot Warfare files already exist for {game} that botLANd did not install. Install replaces them with the latest version and the old files are not kept. Continue?', { game: target.short }))) return;
    if (prompts[operation] && !window.confirm(prompts[operation])) return;
    const done: Record<BotOperation, string> = { install: 'installed', update: 'updated', reinstall: 'reinstalled', remove: 'removed' };
    // Re-read status even after a failure: a rolled-back or partial change still alters what is on disk.
    action(`bot-${operation}`, async () => { try { await window.manager.botAction(target.id, operation); } finally { setBotRevision(previous => previous + 1); } }, t('Bot Warfare {action} for {game}.', { action: translate(done[operation]), game: target.short }));
  }
  function changeBotChannel(target: Game, channel: 'stable' | 'development') {
    if (busy || busyLock.current || target.modBusy || target.status !== 'stopped') return;
    if (channel === 'development' && !window.confirm(t('Opt in to development builds for {game}? These builds may be untested. Nothing is installed until you explicitly choose Install or Update.', { game: target.short }))) return;
    action('bot-channel', async () => { await window.manager.setBotChannel(target.id, channel); setBotRevision(previous => previous + 1); }, t('Bot Warfare channel set to {channel}. No files were installed.', { channel: translate(channel) }));
  }
  // Stop and Cancel never wait on the global busy flag: a long Bot Warfare
  // download or firewall prompt for one game must not block stopping another.
  async function stopServer(id: GameId) {
    if (stopLocks.current.has(id)) return;
    // Stopping a live server ends the match for everyone on it. Cancelling a
    // start or a pending restart has nothing to lose, so it needs no prompt.
    const target = snapshot?.games.find(entry => entry.id === id);
    if (target?.status === 'running' && !window.confirm(t('Stop the {game} server? This ends the current match for everyone connected.', { game: target.short }))) return;
    stopLocks.current.add(id);
    const scope = selectedRef.current;
    setStopRequests(previous => [...previous, id]);
    try {
      await window.manager.stop(id);
      try { await syncSnapshot(); }
      catch (error) { setNotice({ text: t('Stop request completed, but the status could not be refreshed: {message}. Use Refresh server status to try again.', { message: displayError(error) }), error: true, scope }); }
    }
    catch (error) { setNotice({ text: t('{game}: {message}', { game: target?.short || t('Server'), message: displayError(error) }), error: true, scope }); }
    finally { stopLocks.current.delete(id); setStopRequests(previous => previous.filter(entry => entry !== id)); }
  }
  async function copyDiagnostics() {
    if (busy || busyLock.current) return;
    busyLock.current = true; setBusy('copy-diagnostics'); setNotice(null);
    try {
      const copied = await window.manager.copyDiagnostics();
      setNotice({ text: copied ? t('Safe summary copied. Review it before sharing.') : t('Browser preview: diagnostics copy is simulated; the clipboard was not changed.'), error: false });
    } catch { setNotice({ text: t('Could not copy diagnostics. Try again.'), error: true }); }
    finally { busyLock.current = false; setBusy(null); }
  }
  async function copyConnectAddress(id: GameId, address: string) {
    if (busy || busyLock.current) return;
    busyLock.current = true; setBusy('copy-address'); setNotice(null);
    const scope = selectedRef.current;
    try {
      const copied = await window.manager.copyConnectAddress(id, address);
      setNotice({ text: copied ? document.documentElement.dataset.demo === 'true' ? t('Demo preview: Copy simulated; the clipboard was not changed.') : t('Connect address copied to clipboard.') : t('Could not copy this address. Refresh the running server and try again.'), error: !copied, scope });
    } catch (error) { setNotice({ text: displayError(error), error: true, scope }); }
    finally { busyLock.current = false; setBusy(null); }
  }
  function launchControl(target: Game, onCard = false) {
    const draftPending = selectedId === target.id && ((tab === 'configuration' && (configDirty || configBusy)) || rotationPending);
    // BO1 needs an explicit firewall verification before any Start is offered.
    // The main process rechecks the rule immediately before spawning.
    if (onCard && target.status === 'stopped' && target.installed && (target.blockers.length || (target.id === 'bo1' && !bo1RuleReady))) return <button className="button outline-button setup-button" aria-label={t('Finish setup for {game}', { game: target.title })} onClick={event => { event.stopPropagation(); openGame(target.id); }}><ArrowRight size={15} /> {t('Finish setup')}</button>;
    const reason = startBlockedReason(target);
    if (target.status === 'stopping') return <button className="button stop-button" aria-label={t('Stopping {game} server', { game: target.title })} disabled><Square size={15} fill="currentColor" /> {t('Stopping…')}</button>;
    return target.status === 'running' || target.status === 'starting' || target.status === 'restarting'
      ? <button className="button stop-button" aria-label={target.status === 'starting' ? t('Cancel start for {game}', { game: target.title }) : t('Stop server for {game}', { game: target.title })} disabled={stopRequests.includes(target.id)} onClick={event => { event.stopPropagation(); stopServer(target.id); }}><Square size={15} fill="currentColor" /> {target.status === 'starting' ? (stopRequests.includes(target.id) ? t('Cancelling…') : t('Cancel start')) : stopRequests.includes(target.id) ? t('Stopping…') : t('Stop server')}</button>
      : <div className="launch-start"><button className="button primary-button" aria-label={busy === `start-${target.id}` ? t('Starting {game} server', { game: target.title }) : t('Start server for {game}', { game: target.title })} disabled={!!busy || draftPending || !!target.engineBusy || !target.installed || !!target.blockers.length || (target.id === 'bo1' && !bo1RuleReady) || target.status !== 'stopped'} title={reason} onClick={event => { event.stopPropagation(); action(`start-${target.id}`, () => window.manager.start(target.id)); }}><Play size={16} fill="currentColor" /> {busy === `start-${target.id}` ? t('Starting…') : t('Start server')}</button>{!onCard && reason && <span className="launch-blocked-reason" role="status">{reason}</span>}</div>;
  }
  // Explains a disabled Start instead of leaving the user to guess.
  function startBlockedReason(target: Game) {
    if (busy === `start-${target.id}`) return undefined;
    if (!target.installed) return t('{game} was not detected. Choose its game folder first.', { game: target.short });
    if (target.engineBusy) return t('Wait for the {engine} engine update to finish.', { engine: target.engine });
    if (target.blockers.length) return tp('{count} setup issue: {issue}', '{count} setup issues: {issue}', target.blockers.length, { count: target.blockers.length, issue: target.blockers[0] });
    if (target.id === 'bo1' && !bo1RuleReady) return t('Verify the BO1 public inbound UDP firewall rule on the Overview tab before starting.');
    if (selectedId === target.id && ((tab === 'configuration' && (configDirty || configBusy)) || rotationPending)) return t('Save or discard changes before starting this server.');
    if (busy) return t('Wait for the current task to finish: {task}.', { task: translate(busyText(busy)) });
    return undefined;
  }
  function updateGameEngine(target: Game) {
    const id = target.id;
    if ((id !== 'cod4' && id !== 'mw2') || !target.installed || target.status !== 'stopped' || target.engineBusy || target.modBusy ||
        (id === 'mw2' && target.blockers.some(issue => issue.includes('IW4x update journal remains'))) || busy || busyLock.current) return;
    const warning = id === 'cod4'
      ? t('Install the verified Cod4R DedRun executable in the CoD4 folder? This replaces an existing DedRun only with your approval. IW3x fast files and the client are NOT updated; use the official hosting guide for those.')
      : t('Run the official IW4x launcher in update-only mode in the MW2 Steam game folder? It requires a legitimate Steam install and may replace IW4x-managed files beyond iw4x.exe. Back up custom engine files first. It will not launch the game.');
    if (!window.confirm(t('{warning} Stop any other IW3x/IW4x game or launcher processes before continuing.', { warning }))) return;
    action(`engine-${id}`, () => window.manager.updateEngine(id), id === 'cod4'
      ? t('Cod4R DedRun installed. Check the IW3x hosting guide for any fast-file updates.')
      : t('IW4x launcher finished. Review readiness before starting the server.'));
  }
  function engineSidebarReason(target: Game) {
    if (!target.installed) return t('Choose the {game} game folder on its Overview first.', { game: target.short });
    if (target.engineBusy) return t('{engine} is being updated.', { engine: target.engine });
    if (target.modBusy) return t('Wait for the {game} Bot Warfare change to finish.', { game: target.short });
    if (target.status !== 'stopped') return t('Stop the {game} server before updating its engine.', { game: target.short });
    if (target.id === 'mw2' && target.blockers.some(issue => issue.includes('IW4x update journal remains'))) return t('Inspect and repair the interrupted IW4x update before trying again.');
    if (busy) return t('Wait for the current task to finish: {task}.', { task: translate(busyText(busy)) });
    return null;
  }
  function updatePlutonium() {
    if (!snapshot) return;
    const installing = !snapshot.plutonium.installed;
    action('plutonium', () => window.manager.updatePlutonium(), installing ? t('Plutonium installed.') : t('Plutonium is up to date.'));
  }
  // The green "Paste key" step. The field only exists when pasting can work, so
  // when it is missing, point at the Server key panel and say why instead of doing nothing.
  function focusKeyField(id: GameId) {
    const field = document.getElementById(`key-${id}`);
    if (field) {
      field.scrollIntoView({ behavior: 'smooth', block: 'center' });
      field.focus({ preventScroll: true });
      return;
    }
    document.getElementById(`key-panel-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setNotice({ text: t('The key cannot be pasted yet. See the Server key panel for what to fix first.'), error: true, scope: id });
  }
  function setupSteps(target: Game): SetupStep[] {
    const setup = target.setup;
    const locked = !!busy || !!target.engineBusy || target.status !== 'stopped';
    const engineNeedsReview = target.id === 'mw2' && target.blockers.some(issue => issue.includes('IW4x update journal remains'));
    const steps: SetupStep[] = [{
      key: 'folder', title: t('Find the game'), done: setup.folder,
      detail: setup.folder ? t('Found {where}.', { where: target.pathSource === 'steam' ? t('in your Steam library') : t('in the folder you chose') }) : t('Install {game} through Steam and click Rescan, or choose the folder it is installed in.', { game: target.title }),
      action: setup.folder ? undefined : { label: t('Browse game folder'), icon: FolderOpen, disabled: !!busy, run: () => action('folder', () => window.manager.chooseFolder(target.id)) },
      secondary: setup.folder ? undefined : { label: 'Rescan', disabled: !!busy, run: () => action('rescan', () => window.manager.rescanInstallations(), t('Installation scan complete.')) },
    }];
    if (setup.engine !== null) steps.push({
      key: 'engine', title: t('Install {engine}', { engine: target.engine }), done: setup.engine && setup.folder,
      detail: setup.engine && setup.folder ? t('{engine} was found. Optional updates are under {tool} at the bottom left; they never run automatically.', { engine: target.engine, tool: target.id === 'cod4' ? 'IW3x' : 'IW4x' }) : !setup.folder ? t('Find the {game} folder first, then use Install {tool} at the bottom left.', { game: target.title, tool: target.id === 'cod4' ? 'IW3x' : 'IW4x' }) : target.engineBusy ? t('Installing or updating {engine}…', { engine: target.engine }) : engineNeedsReview ? t('An interrupted IW4x launcher run needs manual inspection. See Server readiness below and use the official guide.') : t('Use Install {tool} at the bottom left. The official guide covers any other required files.', { tool: target.id === 'cod4' ? 'IW3x' : 'IW4x' }),
      action: setup.engine && setup.folder ? undefined : { label: t('Open setup guide'), icon: ExternalLink, disabled: !!busy, run: () => action('engine-guide', () => window.manager.openEngineGuide(target.id)) },
    });
    if (setup.plutonium !== null) {
      const updating = snapshot?.plutonium.updating;
      steps.push({
        key: 'plutonium', title: t('Install Plutonium'), done: setup.plutonium,
        detail: updating ? t('Plutonium is being downloaded and updated…') : setup.plutonium ? t('Installed{updated}. botLANd checks for updates before each start.', { updated: snapshot?.plutonium.lastUpdated ? t(', last updated {date}', { date: formatDate(snapshot.plutonium.lastUpdated) }) : '' }) : !snapshot?.plutonium.available ? t('Plutonium installation is unavailable for this Windows account. Check LOCALAPPDATA and refresh server status before retrying.') : t('Plutonium runs this server. botLANd downloads it from plutonium.pw and keeps it up to date.'),
        action: setup.plutonium ? undefined : { label: updating ? t('Installing…') : t('Install Plutonium'), icon: Download, disabled: !!busy || !!updating || !snapshot?.plutonium.available, run: updatePlutonium },
      });
    }
    if (setup.key !== null) steps.push({
      key: 'key', title: t('Add your server key'), done: setup.key,
      detail: setup.key ? (document.documentElement.dataset.demo === 'true' ? t('Sample key status set for this browser preview only.') : t('Saved securely on this PC.')) : target.keyStatus === 'unavailable' ? (target.keyReason === 'damaged' ? t('The saved key file is damaged. Use Reset key storage in the Server key panel, then paste the key again.') : target.keyReason === 'encryption-unavailable' ? t('Windows encryption is unavailable, so keys cannot be stored. See the Server key panel.') : t('The saved key cannot be read by this Windows profile. Paste the key again to replace it.')) : t('Create a free server key on the Plutonium website, then paste it here.'),
      action: setup.key ? undefined : { label: t('Paste key'), icon: KeyRound, disabled: !!busy, run: () => focusKeyField(target.id) },
      secondary: setup.key ? undefined : { label: t('Get a key'), disabled: !!busy, run: () => action('key-page', () => window.manager.openKeyPage()) },
    });
    steps.push({
      key: 'bots', title: t('Install Bot Warfare'), done: setup.bots,
      detail: setup.bots ? t('The bot mod is installed.') : target.modBusy ? t('Installing Bot Warfare…') : currentBotState?.loading || !currentBotState ? t('Checking the official Bot Warfare release…') : currentBotState.error ? t('Release status could not be read. Retry in the Bot Warfare panel.') : !currentBotState.status?.source.supported ? t('No verified release is available right now. See the Bot Warfare panel for details and retry when online.') : currentBotState.status.state === 'installed' ? t('The managed mod is incomplete. Reinstall the latest release to replace its files; back up any custom changes first.') : t('Adds the bots that fill your server. Downloaded from the official ineedbots release.'),
      action: setup.bots ? undefined : { label: target.modBusy ? t('Installing…') : currentBotState?.status?.state === 'installed' ? t('Reinstall Bot Warfare') : t('Install Bot Warfare'), icon: Download, disabled: locked || !setup.folder || target.modBusy || !currentBotState?.status?.source.supported, run: () => manageBot(target, currentBotState?.status?.state === 'installed' ? 'reinstall' : 'install') },
    });
    steps.push({
      key: 'config', title: t('Create the server config'), done: setup.config,
      detail: setup.config ? t('Ready. Change server name, slots and bots on the Configuration tab.') : target.configMissing ? t('Creates a ready-to-use server config with sensible bot settings.') : setup.folder ? t('The server config needs a fix. See Server readiness below.') : t('Find the game first.'),
      action: setup.config ? undefined : target.configMissing ? { label: t('Create server config'), icon: Settings2, disabled: !!busy || !setup.folder, run: () => action('starter', () => window.manager.createStarterConfig(target.id), t('Server config created. You can change its settings on the Configuration tab.')) }
        : { label: t('Open Configuration'), icon: SlidersHorizontal, disabled: !setup.folder, run: () => selectTab('configuration') },
    });
    steps.push({
      key: 'maps', title: t('Pick a mode and maps'), done: setup.maps,
      detail: setup.maps ? t('{maps} in rotation.', { maps: target.options.selectedMaps.length ? tp('{count} map selected', '{count} maps selected', target.options.selectedMaps.length, { count: target.options.selectedMaps.length }) : t('Every installed map') }) : setup.folder ? t('The saved mode or maps are not available. Choose them again.') : t('Find the game first.'),
      action: setup.maps ? undefined : { label: t('Choose maps'), icon: MapIcon, disabled: !setup.folder, run: () => selectTab('rotation') },
      secondary: setup.maps && setup.folder ? { label: 'Change', run: () => selectTab('rotation') } : undefined,
    });
    // BO1 has no LAN mode, so its public inbound rule is required for Start.
    const wanted = target.id === 'bo1' || !target.options.lan ? 'any' : 'lan';
    const firewallDone = firewallStatus?.state === wanted && firewallStatus.managed === true;
    steps.push({
      key: 'firewall', title: t('Allow players through the firewall'), done: firewallDone, optional: target.id !== 'bo1',
      detail: !firewallStatus ? t('Checking the Windows firewall…') : firewallDone ? t('Inbound UDP {port} is allowed {scope}.', { port: firewallStatus.port, scope: wanted === 'lan' ? t('from your local network only') : t('from any address') }) : target.id === 'bo1' ? t('Black Ops always launches public; allow inbound UDP from any address before starting. Players outside your LAN also need router port forwarding. Windows asks for administrator approval.') : t('Recommended for LAN play: without it, Windows can block other PCs from joining. Windows asks for administrator approval.'),
      action: firewallDone || !firewallStatus ? undefined : { label: firewallStatus.state === 'missing' ? t('Create firewall rule') : t('Update firewall rule'), icon: ShieldCheck, disabled: !!busy || !setup.folder, run: () => changeFirewall(target, true) },
    });
    return steps;
  }

  const visibleNotice = notice && (notice.scope === undefined || notice.scope === selectedId) ? notice : null;
  if (!snapshot) return <div className="loading-screen"><Logo /><span>{t('PREPARING YOUR LOBBIES')}</span>{notice?.error ? <><p role="alert">{notice.text}</p><button className="button primary-button" onClick={() => { setNotice(null); syncSnapshot().catch(error => setNotice({ text: displayError(error), error: true })); }}>{t('Retry status check')}</button></> : <div className="loading-line" />}</div>;
  return <div className="app-shell" data-locale={locale}>
    <a className="skip-link" href="#main-content">{t('Skip to content')}</a>
    <aside className="sidebar">
      <button className="brand" onClick={goHome}><Logo /><div><strong>bot<span className="brand-word-accent">LAN</span>d</strong><small>{t('SERVER MANAGER')}</small></div></button>
      <div className="nav-heading">{t('WORKSPACE')}</div>
      <button className={`nav-item ${selectedId === null ? 'active' : ''}`} aria-current={selectedId === null ? 'page' : undefined} onClick={goHome}><LayoutDashboard size={18} /> {t('Dashboard')} <ChevronRight size={15} className="nav-chevron" /></button>
      <div className="nav-heading game-heading">{t('DETECTED GAMES')} <span>{String(detectedGames.length).padStart(2, '0')}</span></div>
      <div className="game-nav">{detectedGames.map(entry => <button key={entry.id} data-game={entry.id} className={`nav-item game-nav-item ${selectedId === entry.id ? 'active' : ''}`} aria-current={selectedId === entry.id ? 'page' : undefined} onClick={() => openGame(entry.id)}><span className={`nav-game-glyph ${entry.family}`}>{gameCodes[entry.id].slice(0, 1)}</span><span className="nav-game-label">{entry.short}<small>{entry.engine}</small></span><span className={`nav-status ${entry.status === 'running' ? 'online' : (entry.status === 'starting' || entry.status === 'stopping' || entry.status === 'restarting' || entry.blockers.length || (entry.id === 'bo1' && !bo1RuleReady)) ? 'attention' : ''}`} aria-hidden="true" /><span className="sr-only">, {statusLabel(entry, firewallFor(entry))}</span></button>)}{!detectedGames.length && <span className="nav-empty">{t('No game folders detected yet.')}</span>}</div>
       {!!activeUnavailableGames.length && <><div className="nav-heading missing-heading">{t('ACTIVE / UNAVAILABLE')} <span>{String(activeUnavailableGames.length).padStart(2, '0')}</span></div><div className="game-nav">{activeUnavailableGames.map(entry => <button key={entry.id} data-game={entry.id} className={`nav-item game-nav-item ${selectedId === entry.id ? 'active' : ''}`} aria-current={selectedId === entry.id ? 'page' : undefined} onClick={() => openGame(entry.id)}><span className={`nav-game-glyph ${entry.family}`}>{gameCodes[entry.id].slice(0, 1)}</span><span className="nav-game-label">{entry.short}<small>{statusLabel(entry, firewallFor(entry))}</small></span><span className={`nav-status ${entry.status === 'running' ? 'online' : 'attention'}`} /></button>)}</div></>}
       {!!missingGames.length && <><div className="nav-heading missing-heading">{t('NOT DETECTED')} <span>{String(missingGames.length).padStart(2, '0')}</span></div><div className="game-nav missing-nav">{missingGames.map(entry => <button key={entry.id} data-game={entry.id} className={`nav-item game-nav-item ${selectedId === entry.id ? 'active' : ''}`} aria-current={selectedId === entry.id ? 'page' : undefined} onClick={() => openGame(entry.id)}><span className={`nav-game-glyph ${entry.family}`}>{gameCodes[entry.id].slice(0, 1)}</span><span className="nav-game-label">{entry.short}<small>{t('Browse to set up')}</small></span></button>)}</div></>}
      <div className="sidebar-footer">{(['cod4', 'mw2'] as const).map(id => { const target = snapshot.games.find(entry => entry.id === id); if (!target) return null; const reason = engineSidebarReason(target); const name = id === 'cod4' ? 'IW3x' : 'IW4x'; return <div key={id} className="engine-sidebar-section"><div className={id === 'cod4' ? 'footer-separator' : 'footer-separator engine-footer-divider'} /><div className="root-label"><Download size={15} /> {name.toUpperCase()}</div><div className="engine-sidebar-item"><button className="root-button" data-engine={id} aria-label={t('{action} {engine} for {game}', { action: target.setup.engine ? t('Update') : t('Install'), engine: name, game: target.title })} disabled={!!reason} title={reason || (id === 'cod4' ? t('Installs the verified Cod4R DedRun only; IW3x fast files need the official guide.') : t('Runs the official IW4x launcher in update-only mode; back up custom engine files first.'))} onClick={() => updateGameEngine(target)}><Download size={15} /> {target.engineBusy ? t('Updating…') : t('{action} {engine}', { action: target.setup.engine ? t('Update') : t('Install'), engine: name })} <ArrowRight size={14} /></button>{!target.installed && <span className="engine-sidebar-hint">{t('Choose {game} folder first', { game: target.short })}</span>}{id === 'mw2' && target.blockers.some(issue => issue.includes('IW4x update journal remains')) && <span className="engine-sidebar-hint">{t('Manual review required')}</span>}</div></div>; })}<div className="footer-separator engine-footer-divider" /><div className="root-label"><Download size={15} /> {t('PLUTONIUM')}</div><div className="root-path" title={snapshot.plutonium.error || undefined}>{snapshot.plutonium.updating ? t('Updating…') : !snapshot.plutonium.installed ? t('Not installed') : snapshot.plutonium.lastUpdated ? t('Updated {date}', { date: formatDate(snapshot.plutonium.lastUpdated) }) : t('Installed')}</div>{snapshot.plutonium.available && <button className="root-button" disabled={!!busy || snapshot.plutonium.updating || plutoniumRunning} title={plutoniumRunning ? t('Stop the Plutonium servers (WaW, BO1, MW3, BO2) first') : t('Used by World at War, Black Ops, MW3 and Black Ops II. botLANd also checks for updates before each start.')} onClick={updatePlutonium}><Download size={15} /> {snapshot.plutonium.installed ? t('Update Plutonium') : t('Install Plutonium')} <ArrowRight size={14} /></button>}<div className="sidebar-version">{t('botLANd')} <span>{t('LOCAL /')} {__APP_VERSION__}</span></div></div>
    </aside>
    <main id="main-content" ref={mainPane} className="main-pane" tabIndex={-1} aria-label={game ? t('{game} — {section}', { game: game.title, section: translate(tabs.find(item => item.id === tab)?.label || 'Overview') }) : t('Dashboard')}>
      <header className="topbar"><div className="breadcrumbs"><span>{t('WORKSPACE')}</span><ChevronRight size={14} /><strong>{game ? game.short.toUpperCase() : t('DASHBOARD')}</strong></div><div className="topbar-right">{busy && <span className="busy-indicator" role="status"><RefreshCw size={13} className="busy-spin" aria-hidden="true" /> {translate(busyText(busy))}…{busyTick > 0 && busySince.current ? ` ${Math.max(1, Math.round((Date.now() - busySince.current) / 1000))}s` : ''}</span>}<span className="local-label"><span className="local-pulse" /> {t('LOCAL MACHINE')}</span><button className="icon-button" aria-label={t('Refresh server status and rescan installations')} title={busy ? t('Wait for the current task to finish') : t('Refresh server status and rescan installations')} disabled={!!busy} onClick={refreshWorkspace}><RefreshCw size={17} /></button></div></header>
      <div className="page-content">
        <div className="sr-only" role="status" aria-live="polite">{game ? `${game.short} server: ${statusLabel(game, firewallFor(game))}` : ''}</div>
        {game && <div className="sr-only" role="status" aria-live="polite">{tabs.find(item => item.id === tab)?.label || ''} {'panel'}</div>}
        {visibleNotice && <div className={`notice ${visibleNotice.error ? 'notice-error' : 'notice-success'}`} role={visibleNotice.error ? 'alert' : 'status'}>{visibleNotice.error ? <TriangleAlert size={17} /> : <Check size={17} />}<span>{visibleNotice.text}</span><button onClick={() => setNotice(null)} aria-label={t('Dismiss')}><X size={16} /></button></div>}
        {!game ? <>
          <section className="dashboard-intro"><div><div className="eyebrow"><span className="eyebrow-line" /> {t('YOUR COMMAND CENTER')}</div><h1>{t('Make the lobby')} <em>{t('yours.')}</em></h1><p>{t('Manage the games detected on this PC. Add another game by choosing its installed folder below.')}</p></div><div className="intro-mark" aria-hidden="true"><span>{t('BL')}<span>.</span></span></div></section>
          {snapshot.games.some(entry => entry.orphan) && <section className="dashboard-orphans" role="status"><div><TriangleAlert size={18} /><span><strong>{t('Possible unmanaged server processes')}</strong><small>{snapshot.games.filter(entry => entry.orphan).map(entry => t('{game}: {process}, UDP {port}', { game: entry.short, process: entry.orphan?.pid != null ? `PID ${entry.orphan.pid}` : t('unidentified process'), port: entry.orphan?.port ?? '' })).join(' · ')}{t('. Inspect these processes in Windows Task Manager; botLANd cannot adopt or stop them.')}</small></span></div><button className="button outline-button" disabled={!!busy} onClick={() => action('rescan-orphans', () => window.manager.rescanOrphans(), t('Process scan complete.'))}><RefreshCw size={15} /> {t('Rescan processes')}</button></section>}
           {snapshot.detectError && <div className="notice notice-error" role="alert"><TriangleAlert size={17} /><span>{snapshot.detectError}</span></div>}
          {bo1OnDashboard?.installed && !bo1RuleReady && <div className="dashboard-bo1-guidance" role="status"><ShieldCheck size={18} /><span>{t('Black Ops is public only. Before Start, open BO1’s Overview and apply a verified botLANd inbound UDP firewall rule allowing any address.')}</span><button className="inline-link" onClick={() => openGame('bo1')}>{t('Open BO1 Overview')} <ArrowRight size={14} /></button></div>}
           <div className="stats-row"><div className="stat-card"><div className="stat-icon"><Server size={21} /></div><div><span>{t('GAMES DETECTED')}</span><strong>{String(detectedGames.length).padStart(2, '0')} <small>/ {String(snapshot.games.length).padStart(2, '0')} {t('SUPPORTED')}</small></strong></div></div><div className="stat-card"><div className="stat-icon green"><Activity size={21} /></div><div><span>{t('RUNNING NOW')}</span><strong>{String(running).padStart(2, '0')} <small>{running === 1 ? t('SERVER LIVE') : t('SERVERS LIVE')}</small></strong></div></div><div className="stat-card"><div className="stat-icon orange"><ShieldCheck size={21} /></div><div><span>{t('READY TO LAUNCH')}</span><strong>{String(ready).padStart(2, '0')} <small>/ {String(detectedGames.length).padStart(2, '0')} {t('DETECTED')}</small></strong></div></div></div>
          {(!!missingGames.length || detectedGames.some(entry => entry.blockers.length)) && <section className="setup-panel"><div><span className="section-kicker">{t('SETUP CHECKLIST')}</span><h2>{detectedGames.length ? t('Finish setting up your games') : t('Set up your first lobby')}</h2><ol><li>{t('Install your games through Steam, then click Rescan installations.')}</li><li>{t('Click')} <strong>{t('Finish setup')}</strong> {t('on a game and work down its checklist. CoD4 and MW2 engine installs are in the bottom-left sidebar.')}</li><li>{t('Press Start. Your settings, maps and Bot Warfare are all managed here.')}</li></ol></div><button className="button outline-button" disabled={!!busy} onClick={() => action('rescan', () => window.manager.rescanInstallations(), t('Installation scan complete.'))}><RefreshCw size={16} /> {t('Rescan installations')}</button></section>}
           <div className="section-heading"><div><span className="section-kicker">{t('DETECTED ON THIS PC')}</span><h2>{t('Game servers')} <span className="heading-count">{String(dashboardGames.length).padStart(2, '0')}</span></h2></div><span className="section-sub">{t('SELECT A GAME TO MANAGE ITS SERVER')} <ArrowRight size={15} /></span></div>
           {!dashboardGames.length && <div className="empty-install"><FolderOpen size={27} /><div><strong>{t('No game folders detected.')}</strong><p>{t('Install a supported game, rescan, or select a game below to browse to an existing folder. Engine, mods and config are checked before launch.')}</p></div></div>}
          {/* The card is a mouse shortcut only; MANAGE is its keyboard and screen-reader control. */}
          <div className="server-grid">{dashboardGames.map(entry => <div key={entry.id} className={`server-card accent-${entry.family}`} onClick={() => openGame(entry.id)}><div className={`card-art ${artReadyFor(entry.id, 'cover') ? 'has-image' : ''} ${artReadyFor(entry.id, 'cover') && artReadyFor(entry.id, 'logo') ? 'has-logo' : ''}`}><img key={artUrlFor(entry.id, 'cover', entry.gamePath)} className="card-art-image" src={artUrlFor(entry.id, 'cover', entry.gamePath)} alt="" decoding="async" onLoad={() => markArt(entry.id, 'cover', true)} onError={event => { event.currentTarget.hidden = true; markArt(entry.id, 'cover', false); }} /><div className="card-grid-pattern" /><div className="card-ring ring-a" /><div className="card-ring ring-b" /><span className="card-art-number" aria-hidden="true">{gameNumbers[entry.id]}</span><img key={artUrlFor(entry.id, 'logo', entry.gamePath)} className="card-logo" src={artUrlFor(entry.id, 'logo', entry.gamePath)} alt="" decoding="async" onLoad={() => markArt(entry.id, 'logo', true)} onError={event => { event.currentTarget.hidden = true; markArt(entry.id, 'logo', false); }} /><span className="card-art-code" aria-hidden="true">{gameCodes[entry.id]}</span></div><div className="server-card-body"><div className="card-topline"><span>{entry.engine.toUpperCase()}</span><span className={`card-visibility ${entry.id === 'bo1' || !entry.options.lan ? 'public' : ''}`}>{entry.id === 'bo1' ? t('PUBLIC ONLY') : t('NEXT: {scope}', { scope: entry.options.lan ? t('LAN') : t('PUBLIC') })}</span><StateChip game={entry} firewall={firewallFor(entry)} /></div><h3>{entry.title}</h3>{snapshot.updates[entry.id]?.updateAvailable === true && <span className="bot-update-badge card-bot-badge">{t('BOT WARFARE UPDATE')}</span>}<p>{entry.subtitle} <span className="dot-separator">·</span> {t('UDP')} {entry.activePort ?? entry.options.port}{entry.activePort != null && entry.activePort !== entry.options.port ? t(' (next: {port})', { port: entry.options.port }) : ''}</p>{entry.orphan && <span className="card-orphan"><TriangleAlert size={12} /> {t('Possible unmanaged')} {entry.orphan.pid != null ? `PID ${entry.orphan.pid}` : t('process on UDP {port}', { port: entry.orphan.port })}</span>}<div className="card-actions">{launchControl(entry, true)}<button className="card-open" aria-label={t('Manage {game}', { game: entry.title })} onClick={event => { event.stopPropagation(); openGame(entry.id); }}>{t('MANAGE')} <ArrowRight size={16} aria-hidden="true" /></button></div></div></div>)}</div>
          {!!missingGames.length && <section className="missing-section"><div className="section-heading"><div><span className="section-kicker">{t('ADD A GAME')}</span><h2>{t('Not detected')} <span className="heading-count">{String(missingGames.length).padStart(2, '0')}</span></h2></div><span className="section-sub">{t('NO GAME FOLDER DETECTED')}</span></div><div className="missing-list">{missingGames.map(entry => <div className="missing-row" key={entry.id}><span className={`nav-game-glyph ${entry.family}`}>{gameCodes[entry.id].slice(0, 1)}</span><div><strong>{entry.title}</strong><small>{entry.engine} {t('· Choose an existing game folder to begin.')}</small></div><button className="button outline-button" disabled={!!busy} onClick={() => action('folder', () => window.manager.chooseFolder(entry.id))}><FolderOpen size={15} /> {t('Browse folder')}</button><button className="inline-link" onClick={() => openGame(entry.id)}>{t('Set up')} <ArrowRight size={14} /></button></div>)}</div></section>}
           <section className="panel update-settings"><div className="panel-heading compact"><div><span className="section-kicker">{t('SETTINGS')}</span><h2>{t('Bot Warfare update checks')}</h2></div><button className="button outline-button" disabled={!!busy} onClick={() => action('check-updates', () => window.manager.checkBotUpdates(), t('Update check finished. See per-game status below; no mods were installed.'))}><RefreshCw size={15} /> {busy === 'check-updates' ? t('Checking…') : t('Check now')}</button></div><label className="toggle-row"><span className={`toggle ${snapshot.updatesEnabled ? 'on' : ''}`}><input type="checkbox" aria-label={t('Check for Bot Warfare updates automatically')} checked={snapshot.updatesEnabled} disabled={!!busy} onChange={event => action('update-checks', () => window.manager.setUpdateChecks(event.target.checked), t('Automatic update checks {state}.', { state: event.target.checked ? t('enabled') : t('disabled') }))} /><span /></span><span><strong>{t('Check for updates automatically')}</strong><small>{snapshot.updatesEnabled ? t('On') : t('Off')} {t('· Checks never install or change game files.')}</small></span></label>{LOCALES.filter(item => item.userFacing).length > 1 && <label className="toggle-row"><span>{t('Interface language')}</span><select value={locale} onChange={event => { const next = event.target.value; setLocale(next); window.manager.setLocale(next).catch(() => setLocale(snapshot.locale || 'en')); }}>{LOCALES.filter(item => item.userFacing).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}<div className="update-status-list" aria-label={t('Update check results')}>{detectedGames.map(entry => <div key={entry.id}><strong>{entry.short}</strong><span>{snapshot.updates[entry.id]?.status ? updateStatus(snapshot.updates[entry.id]!.status) : snapshot.updatesEnabled ? t('Not checked yet') : t('Checks off')}{snapshot.updates[entry.id]?.updateAvailable === true ? t(' · Update available') : ''}</span></div>)}</div><p className="update-disclosure"><Info size={16} /> {t('On by default: botLANd contacts api.github.com at most once every 18 hours using a standard request to look for Bot Warfare versions. No account or keys are sent. A failed check (offline or rate limited) is retried after about 10 minutes; no updates install automatically. You can turn this off here at any time.')}</p></section>
            <section className="panel diagnostics-panel"><div><span className="section-kicker">{t('SUPPORT')}</span><h2>{t('Copy diagnostics')}</h2><p>{t('Copies only the app version, platform, and per-game readiness counts. No logs, paths, addresses, keys, or config values. Review the summary before sharing it.')}</p></div><button className="button outline-button" disabled={!!busy} onClick={copyDiagnostics}><Copy size={15} /> {busy === 'copy-diagnostics' ? t('Copying…') : t('Copy diagnostics')}</button></section>
            <div className="dashboard-note"><Info size={17} /><span>{t('Only detected games appear as server cards. Preflight checks determine whether Start is available. Public players also need the game\'s UDP port opened or forwarded on their router.')}</span></div>
        </> : <>
          <div className="detail-back"><button onClick={goHome}><ArrowLeft size={16} /> {t('ALL SERVERS')}</button><span>/</span><span>{game.short.toUpperCase()}</span></div>
          <section className={`detail-hero accent-${game.family} ${artReadyFor(game.id, 'hero') ? 'has-image' : ''}`}><img key={artUrlFor(game.id, 'hero', game.gamePath)} className="detail-hero-image" src={artUrlFor(game.id, 'hero', game.gamePath)} alt="" decoding="async" onLoad={() => markArt(game.id, 'hero', true)} onError={event => { event.currentTarget.hidden = true; markArt(game.id, 'hero', false); }} /><div className="detail-hero-art" aria-hidden="true"><span>{gameCodes[game.id]}</span></div><div className="detail-hero-content"><div className="eyebrow"><span className="eyebrow-line" /> {game.engine.toUpperCase()} <span className="eyebrow-divider">/</span> {t('DEDICATED SERVER')}</div><h1>{game.title}</h1><p>{game.subtitle} <span>·</span> {game.id === 'bo1' ? t('PUBLIC ONLY') : t('NEXT START: {scope}', { scope: game.options.lan ? t('LAN') : t('PUBLIC') })} {t('BOT SERVER')}</p><div className="detail-hero-bottom"><StateChip game={game} firewall={firewallFor(game)} />{snapshot.updates[game.id]?.updateAvailable === true && <span className="bot-update-badge">{t('BOT WARFARE UPDATE')}</span>}<span className="hero-port"><Radio size={15} /> {t('UDP')} {game.activePort ?? game.options.port}{game.activePort != null && game.activePort !== game.options.port ? t(' (next: {port})', { port: game.options.port }) : ''}</span><span className="hero-port"><Gamepad2 size={15} /> {game.engine}</span>{game.installed && <VisibilitySwitch game={game} disabled={!!busy} onChange={next => changeVisibility(game, next)} />}</div></div><div className="detail-hero-action">{game.installed || game.status !== 'stopped' ? launchControl(game) : <button className="button primary-button" disabled={!!busy} onClick={() => action('folder', () => window.manager.chooseFolder(game.id))}><FolderOpen size={16} /> {t('Browse game folder')}</button>}</div></section>
          <nav className="detail-tabs" aria-label={t('Game sections')} role="tablist">{tabs.map(item => <button key={item.id} data-tab={item.id} role="tab" id={`tab-${item.id}`} aria-controls={tab === item.id ? `panel-${item.id}` : undefined} aria-selected={tab === item.id} className={tab === item.id ? 'selected' : ''} disabled={!game.installed && item.id !== 'overview' && !(item.id === 'console' && game.status !== 'stopped')} onClick={() => selectTab(item.id)}><item.icon size={17} aria-hidden="true" />{translate(item.label)}</button>)}</nav>
          {tab === 'overview' && <div className="detail-layout" role="tabpanel" id="panel-overview" aria-labelledby="tab-overview"><div className="detail-primary"><OrphanWarning game={game} busy={!!busy} onRescan={() => action('rescan-orphans', () => window.manager.rescanOrphans(), t('Process scan complete.'))} /><ConnectPanel key={`${game.id}-${game.startedAt || ''}`} game={game} busy={!!busy} onCopy={address => copyConnectAddress(game.id, address)} /><SetupChecklist key={`setup-${game.id}`} steps={setupSteps(game)} ready={game.installed && !game.blockers.length && !game.engineBusy && (game.id !== 'bo1' || bo1RuleReady)} blockers={game.blockers} start={launchControl(game)} /><RestartPanel game={game} busy={!!busy} now={clock} onChange={enabled => action('auto-restart', () => window.manager.setAutoRestart(game.id, enabled), `Automatic restart ${enabled ? 'enabled' : 'disabled'} for ${game.short}.`)} /><section className="panel"><div className="panel-heading"><div className="panel-icon"><ShieldCheck size={19} /></div><div><span className="section-kicker">{t('PREFLIGHT CHECK')}</span><h2>{t('Server readiness')}</h2></div><span className={`readiness-pill ${!game.installed || game.blockers.length || game.engineBusy || (game.id === 'bo1' && !bo1RuleReady) ? 'bad' : 'good'}`}>{!game.installed ? t('GAME NOT DETECTED') : game.engineBusy ? t('ENGINE UPDATING') : game.blockers.length ? tp('{count} ISSUE', '{count} ISSUES', game.blockers.length, { count: game.blockers.length }) : game.id === 'bo1' && !bo1RuleReady ? t('FIREWALL CHECK NEEDED') : t('ALL CHECKS PASSED')}</span></div>{game.installed && !game.blockers.length && !game.engineBusy && !game.warnings.length && !firewallAdvisory && (game.id !== 'bo1' || bo1RuleReady) ? <div className="all-clear"><div><Check size={20} /></div><div><strong>{t('Everything looks good.')}</strong><span>{t('Your files and launch dependencies are in place. Ready when you are.')}</span></div></div> : <div className="check-list">{game.engineBusy && <div className="check-item"><RefreshCw size={17} /><span>{game.engine} {t('is updating. Wait for the update to finish before starting.')}</span></div>}{!game.installed && !game.blockers.length && <div className="check-item error"><FolderOpen size={17} /><span>{t('No installed game folder was detected. Browse to your existing installation to continue.')}</span></div>}{game.id === 'bo1' && game.installed && !bo1RuleReady && <div className="check-item error"><TriangleAlert size={17} /><span>{t('A verified botLANd public inbound UDP firewall rule is required before starting BO1. Apply it below.')}</span></div>}{game.blockers.map((issue, index) => <div className="check-item error" key={`b-${index}`}><TriangleAlert size={17} /><span>{issue}</span></div>)}{game.warnings.map((issue, index) => <div className="check-item warning" key={`w-${index}`}><Info size={17} /><span>{issue}</span></div>)}{firewallAdvisory && <div className="check-item warning"><Info size={17} /><span>{t('No matching inbound firewall rule for UDP')} {game.activePort ?? game.options.port}{t('. Other PCs may be blocked from joining until you apply one in the Windows firewall panel.')}</span></div>}{game.installed && !game.blockers.length && !game.engineBusy && <div className="check-item success"><Check size={17} /><span>{t('Launch dependencies and config found.')}</span></div>}</div>}</section>
          {game.installed && <section className="panel"><div className="panel-heading"><div className="panel-icon"><SlidersHorizontal size={19} /></div><div><span className="section-kicker">{t('AT A GLANCE')}</span><h2>{t('Current setup')}</h2></div><button className="text-action" onClick={() => selectTab('configuration')}>{t('EDIT SETTINGS')} <ArrowRight size={15} /></button></div><div className="quick-grid"><div><span>{t('PLAYER SLOTS')}</span><strong>{game.config.sv_maxclients || '—'}</strong></div><div><span>{t('BOT FILL TARGET')}</span><strong>{game.config.bots_manage_fill || '—'}</strong></div><div><span>{t('MAPS SELECTED')}</span><strong>{maps ? savedMaps.length : '—'}</strong></div><div><span>{t('GAME MODE')}</span><strong>{maps?.modes.find(mode => mode.value === game.options.mode)?.label || game.options.mode.toUpperCase()}</strong></div></div></section>}</div>
          <div className="detail-secondary"><BotPanel key={`bot-${game.id}`} game={game} status={currentBotState?.status || null} loading={!!game.installed && (!currentBotState || currentBotState.loading)} error={currentBotState?.error || null} busy={!!busy} updateAvailable={snapshot.updates[game.id]?.updateAvailable ?? null} onRetry={() => setBotRevision(previous => previous + 1)} onAction={operation => manageBot(game, operation)} onChannel={channel => changeBotChannel(game, channel)} /><KeyPanel key={`key-${game.id}`} game={game} draft={keyDraft} busy={!!busy} saving={busy === 'key-save'} onDraft={setKeyDraft} onSave={() => savePastedKey(game.id)} onReset={resetKeyStorage} onRemove={() => { if (window.confirm(t('Remove the saved server key? The next launch will need a key.'))) keyAction('key-remove', () => window.manager.removeKey(game.id), t('Saved key removed.')); }} onKeyPage={() => action('key-page', () => window.manager.openKeyPage())} /><section className="panel path-panel"><div className="section-kicker">{t('INSTALLATION')}</div><h2 className="h3-style">{t('Game folder')}</h2><div className="path-display" title={game.gamePath}><FolderOpen size={18} /><span>{game.gamePath || t('Not detected')}</span></div><p className="path-source">{game.pathSource === 'steam' ? t('Detected in your Steam library') : game.pathSource === 'manual' ? t('Selected manually') : t('No folder selected')}</p>{game.detectedPath && game.detectedPath !== game.gamePath && <button className="inline-link detected-folder" disabled={!!busy || game.status !== 'stopped'} onClick={() => action('detected-folder', () => window.manager.useDetectedFolder(game.id), t('Now using the folder detected in your Steam library.'))}>{t('Use detected folder')} <FolderOpen size={13} /></button>}<button className="outline-button full-width" disabled={!!busy} onClick={() => action('folder', () => window.manager.chooseFolder(game.id))}><FolderOpen size={16} /> {t('Browse game folder')}</button><button className="inline-link engine-link" disabled={!!busy} onClick={() => action('engine-guide', () => window.manager.openEngineGuide(game.id))}>{game.engine} {t('setup guide')} <ExternalLink size={14} /></button><div className="panel-divider" /><div className="section-kicker">{t('CONFIG FILE')}</div><div className="path-display smaller" title={game.configPath}><Settings2 size={17} /><span>{game.configPath || t('Not found')}</span></div>{game.installed && game.configMissing && <button className="outline-button full-width" disabled={!!busy} onClick={() => action('starter', () => window.manager.createStarterConfig(game.id), t('Server config created. You can change its settings on the Configuration tab.'))}><Settings2 size={16} /> {t('Create server config')}</button>}<button className="inline-link" disabled={!!busy || !game.installed || !!game.configMissing} onClick={() => action('open', () => window.manager.openConfig(game.id))}>{t('Open original config')} <ExternalLink size={14} /></button>{game.installed && <><div className="panel-divider" /><div className="section-kicker">{t('WINDOWS FIREWALL')}</div><FirewallPanel game={game} status={firewallStatus} busy={!!busy} onApply={() => changeFirewall(game, true)} onRemove={() => changeFirewall(game, false)} /></>}<div className="panel-divider" /><div className="section-kicker">{t('GAME ARTWORK')}</div><p className="artwork-note">{t('Loaded from your local Steam library cache. Custom images stay on this PC.')}</p><div className="artwork-actions"><button onClick={() => changeArtwork(game.id, 'cover')} disabled={!!busy}>{t('Change card image')}</button><button onClick={() => changeArtwork(game.id, 'hero')} disabled={!!busy}>{t('Change header')}</button><button onClick={() => restoreArtwork(game.id, 'cover')} disabled={!!busy}>{t('Steam card image')}</button><button onClick={() => restoreArtwork(game.id, 'hero')} disabled={!!busy}>{t('Steam header')}</button></div></section><section className="panel activity-panel"><div className="panel-heading compact"><div><span className="section-kicker">{t('RECENT ACTIVITY')}</span><h2 className="h3-style">{t('Server output')}</h2></div><button className="text-action" onClick={() => selectTab('console')}>{t('VIEW ALL')} <ArrowRight size={15} /></button></div>{game.logs.length ? game.logs.slice(-3).reverse().map((line, index) => <div className="activity-line" key={index}><span className={line.level === 'error' ? 'activity-error' : ''} /><p>{line.message}</p><time>{gameTime(line.at)}</time></div>) : <div className="activity-empty"><Clock3 size={19} /> {t('No activity yet. Start the server to see its output.')}</div>}</section></div></div>}
          {tab === 'configuration' && <>{!game.installed && <div className="config-notice error" role="alert">{t('The game folder is unavailable. Your unsaved edits are still here; restore the folder before saving, or leave this tab to discard them.')}</div>}<ConfigWorkspace key={game.id} game={game} maps={maps} refreshRevision={refreshRevision} onDirtyChange={setConfigDirty} onBusyChange={setConfigBusy} /></>}
          {tab === 'rotation' && <div className="settings-layout" role="tabpanel" id="panel-rotation" aria-labelledby="tab-rotation"><div className="panel rotation-panel"><div className="panel-heading"><div className="panel-icon"><MapIcon size={19} /></div><div><span className="section-kicker">{t('THE NEXT MATCH')}</span><h2>{t('Maps & modes')}</h2></div></div><p className="panel-description">{t('Only maps found in this installation are listed. A fresh rotation is written when the server starts.')}</p>{rotationPathConflict && <div className="config-path-warning rotation-path-warning" role="alert"><TriangleAlert size={17} /><div><strong>{t('Game folder changed while you were editing.')}</strong><p>{t('This draft belongs to the previous folder. Saving is blocked until you discard it or restore that folder.')}</p><button className="outline-button" disabled={!!busy || !maps || mapLoading} onClick={resetRotationDrafts}>{t('Discard draft and use new folder')}</button></div></div>}{!game.installed && <div className="config-notice error" role="alert">{t('The game folder is unavailable. Your unsaved rotation is preserved; restore the folder before saving, or leave this tab to discard it.')}</div>}{game.installed && mapError && <div className="config-notice error map-scan-error" role="alert"><span>{t('Could not scan maps:')} {mapError} {t('Previous map results cannot be used to save.')}</span><button className="button outline-button" onClick={() => setRefreshRevision(previous => previous + 1)}>{t('Retry map scan')}</button></div>}{!!missingDraftMaps.length && <div className="config-notice error" role="alert"><TriangleAlert size={16} /> {missingDraftMaps.length} {t('selected map')}{missingDraftMaps.length === 1 ? '' : 's'} {t('disappeared after the rescan. Clear or reselect maps before saving.')}</div>}{(missingMaps.length > 0 || missingMode) && <div className="config-notice error" role="alert"><TriangleAlert size={16} /> {missingMaps.length > 0 ? `${tp('{count} saved map no longer installed. ', '{count} saved maps no longer installed. ', missingMaps.length, { count: missingMaps.length })}` : ''}{missingMode ? t('The saved game mode is unavailable. ') : ''}{t('Save updated launch options before starting.')}</div>}<div className="rotation-controls"><label className="form-field"><span>{t('Game mode')}</span><small>{t('Available modes for this game')}</small><select value={modeDraft} disabled={mapLoading || !maps || busy === 'rotation' || rotationPathConflict} onChange={event => setModeDraft(event.target.value)}>{maps?.modes?.length ? maps.modes.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>) : <option value={modeDraft}>{modeDraft}</option>}</select></label><label className="form-field"><span>{t('UDP port')}</span><small>{t('Use a unique port for simultaneous servers')}</small><input type="number" min="1024" max="65535" value={portDraft} disabled={mapLoading || !maps || busy === 'rotation' || rotationPathConflict} aria-invalid={!portValid} aria-describedby={portValid ? undefined : `port-error-${game.id}`} onChange={event => setPortDraft(event.target.value)} /></label>{!portValid && <p className="field-error" id={`port-error-${game.id}`}>{t('UDP port must be a whole number between 1024 and 65535.')}</p>}</div><label className="toggle-row"><span className={`toggle ${shuffleDraft ? 'on' : ''}`}><input type="checkbox" aria-label={t('Shuffle maps on every launch')} checked={shuffleDraft} disabled={mapLoading || !maps || busy === 'rotation' || rotationPathConflict} onChange={event => setShuffleDraft(event.target.checked)} /><span /></span><span><strong>{t('Shuffle on every launch')}</strong><small>{shuffleDraft ? t('Maps are played in a new random order each time.') : t('Maps follow the alphabetical list order below.')}</small></span></label><div className="map-heading"><div><span className="section-kicker">{t('MAP POOL')}</span><h3>{mapLoading ? t('Scanning maps…') : t('{selected} / {total} maps selected', { selected: mapSelection.length, total: maps?.maps.length ?? 0 })}</h3></div><div className="map-tools"><button disabled={mapLoading || !maps || busy === 'rotation' || rotationPathConflict} onClick={() => setMapSelection(maps?.maps || [])}>{t('SELECT ALL')}</button><button disabled={mapLoading || !maps || busy === 'rotation' || rotationPathConflict} onClick={() => setMapSelection([])}>{t('CLEAR')}</button></div></div><div className="map-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label={t('Find a map')} placeholder={t('Find a map…')} value={mapSearch} onChange={event => setMapSearch(event.target.value)} /></div><div className="map-grid" role="group" aria-labelledby="map-pool-heading">{visibleMaps.map(map => <button key={map} type="button" disabled={mapLoading || !maps || busy === 'rotation' || rotationPathConflict} aria-pressed={mapSelection.includes(map)} className={`map-option ${mapSelection.includes(map) ? 'chosen' : ''}`} onClick={() => toggleMap(map)}><span className="map-check">{mapSelection.includes(map) && <Check size={13} />}</span><span><strong>{gameMapName(map)}</strong><small>{map}</small></span></button>)}{!visibleMaps.length && <div className="map-empty">{mapLoading ? t('Looking for installed maps…') : mapSearch.trim() ? t('No installed maps match “{query}”.', { query: mapSearch.trim() }) : mapError ? t('Map scan failed. Retry above to load installed maps.') : t('No installed multiplayer maps were found. Check your game folder.')}</div>}</div><div className="form-footer"><div><Info size={17} /> {t('Your rotation is generated at launch.')}{maps && maps.maps.length > 0 && maps.maps.every(map => mapSelection.includes(map)) ? t(' With every map selected, maps you install later are included too.') : ''}</div><div className="form-footer-actions">{rotationPending && <button className="outline-button" disabled={!!busy} onClick={resetRotationDrafts}>{t('Discard changes')}</button>}<button className="button primary-button" disabled={!!busy || !game.installed || !maps || mapLoading || rotationPathConflict || !portValid || !!missingDraftMaps.length || !(rotationDirty || missingMaps.length > 0 || missingMode)} title={rotationDirty || missingMaps.length > 0 || missingMode ? undefined : t('No unsaved changes')} onClick={saveRotation}><Save size={16} /> {busy === 'rotation' ? t('Saving…') : t('Save launch options')}</button></div></div></div><aside className="settings-aside"><div className="panel"><div className="panel-icon featured"><ListFilter size={20} /></div><h3>{t('Built for this game.')}</h3><p>{t('Map availability and rotation syntax differ between engines. BotLANd uses this title’s own map format and skips anything missing from your installation.')}</p><div className="rotation-summary"><span>{t('ROTATION ENGINE')}</span><strong>{game.engine}</strong><span>{t('OUTPUT')}</span><strong>{game.id === 'mw3' ? t('DSR + map rotation') : game.id === 'bo2' ? t('ExecGTS + map rotation') : t('Map rotation config')}</strong></div></div><div className="aside-tip"><Info size={18} /><p>{t('A different port lets you run multiple servers at once. After changing it, update the Windows firewall rule on the')} <button className="inline-link" onClick={() => selectTab('overview')}>{t('Overview tab')}</button>.</p></div></aside></div>}
          {tab === 'console' && <ConsolePanel game={game} />}
        </>}
      </div>
      <footer className="app-footer"><span>{t('botLANd SERVER MANAGER')}</span><span>{t('LOCAL CONTROL. YOUR SERVERS. YOUR RULES.')}</span></footer>
    </main>
  </div>;
}
