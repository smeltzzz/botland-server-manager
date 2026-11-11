export type GameId = 'cod4' | 'waw' | 'mw2' | 'bo1' | 'mw3' | 'bo2';
export type GameStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'restarting';
export interface LogEntry { at: string; level: string; message: string; source?: 'manager' | 'stdout' | 'stderr' | 'file' }
export interface ConnectCandidate { adapter: string; address: string; scope: string; label: string; connectAddress: string }
export interface ConnectAddresses { primaryAddress: string | null; ambiguous: boolean; candidates: ConnectCandidate[] }
// The PID is unknown when the two address families disagree or one query failed;
// a null PID still means "this port looks occupied", so the warning must survive.
export interface OrphanCandidate { pid: number | null; port: number; reason: string }
export interface RestartState { enabled: boolean; attempts: number; nextAttemptAt: string | null; cutOff: boolean }
export interface ConfigBackup { id: string; date: string; bytes: number }
export interface ConfigRestorePreview { token: string; summary: { changed: boolean; currentBytes: number; backupBytes: number; contents: string } }
export interface GameSetup { folder: boolean; engine: boolean | null; plutonium: boolean | null; key: boolean | null; bots: boolean; config: boolean; maps: boolean }
export type ArtworkKind = 'hero' | 'cover' | 'logo';
export interface Game {
  id: GameId;
  title: string;
  short: string;
  subtitle: string;
  family: 'mw' | 'bo' | 'neutral';
  engine: string;
  configPath: string;
  gamePath: string;
  installed: boolean;
  pathSource: 'manual' | 'steam' | 'none';
  keyStatus: 'not-required' | 'stored' | 'missing' | 'unavailable';
  /** The game is installed but its server config file does not exist yet. */
  configMissing?: boolean;
  /** Setup checklist steps: done (true), to do (false) or not applicable (null). */
  setup: GameSetup;
  modBusy: boolean;
  connect: ConnectAddresses;
  orphan: OrphanCandidate | null;
  restart: RestartState;
  config: Record<string, string>;
  options: { port: number; mode: string; shuffle: boolean; selectedMaps: string[]; gamePath: string; lan: boolean };
  blockers: string[];
  warnings: string[];
  status: GameStatus;
  pid: number | null;
  startedAt: string | null;
  activePort?: number | null;
  logs: LogEntry[];
}
export interface BotManifest { channel: string; ref: string; refType: 'tag' | 'commit'; sha256: string; date: string; repo: string; patches: string[] }
export interface BotStatus { state: 'installed' | 'unknown' | 'not-installed'; targetPath: string; manifest: BotManifest | null; versions: { versionId: string; date: string; manifest: { ref: string; channel: string } | null }[]; channel: 'stable' | 'development'; source: { supported: boolean; ref: string | null; notes: string; status: string } }
export interface BotUpdate { status: string; latest: { tag?: string; commit?: string; developmentCommit?: string | null }; updateAvailable: boolean | null }
export interface PlutoniumStatus { available: boolean; installed: boolean; updating: boolean; lastUpdated: string | null; error: string | null }
export interface Snapshot { games: Game[]; updatesEnabled: boolean; updates: Partial<Record<GameId, BotUpdate>>; plutonium: PlutoniumStatus }
export interface MapData { maps: string[]; modes: { value: string; label: string }[] }
export type ConfigTarget = 'base' | 'mode';
export interface ConfigField { key: string; sourceKey: string; section: string; label: string; hint?: string; type: 'text' | 'integer' | 'decimal' | 'select'; choices?: { value: string; label: string }[]; min?: number; max?: number; maxLength?: number; default?: string; presentOnly?: boolean; allowEmpty?: boolean; dependsOn?: { key: string; value: string } }
export interface ConfigEntry { key: string; value: string; masked: boolean; hasValue: boolean; count: number }
export interface ConfigDocument { path: string; target: ConfigTarget; mode: string; sourceRepo: string; fields: ConfigField[]; values: Record<string, string>; entries: ConfigEntry[] }
export interface ConfigPreview { token: string; changed: boolean; changes: { key: string; label: string; before: string; after: string; duplicates: number }[] }
export type FirewallState = 'missing' | 'lan' | 'any' | 'drift' | 'unknown';
export interface FirewallStatus { name: string; port: number; state: FirewallState }
export type ManagerEvent = { type: 'state'; snapshot: Snapshot } | { type: 'log'; id: GameId; entry: LogEntry };
export interface ManagerApi {
  snapshot(): Promise<Snapshot>;
  copyDiagnostics(): Promise<boolean>;
  setUnsavedChanges(dirty: boolean): Promise<boolean>;
  maps(id: GameId): Promise<MapData>;
  start(id: GameId): Promise<void>;
  stop(id: GameId): Promise<void>;
  chooseFolder(id: GameId): Promise<boolean>;
  rescanInstallations(): Promise<void>;
  createStarterConfig(id: GameId): Promise<string>;
  copyConnectAddress(id: GameId, address: string): Promise<boolean>;
  setAutoRestart(id: GameId, enabled: boolean): Promise<void>;
  rescanOrphans(): Promise<void>;
  listConfigBackups(id: GameId, target: ConfigTarget, mode: string): Promise<ConfigBackup[]>;
  previewConfigRestore(id: GameId, target: ConfigTarget, mode: string, backupId: string): Promise<ConfigRestorePreview>;
  restoreConfigBackup(id: GameId, target: ConfigTarget, mode: string, backupId: string, token: string): Promise<{ backupId: string }>;
  pruneConfigBackups(id: GameId, target: ConfigTarget, mode: string, ids: string[]): Promise<{ removed: number }>;
  botStatus(id: GameId): Promise<BotStatus>;
  botAction(id: GameId, operation: 'install' | 'update' | 'reinstall' | 'remove' | 'restore', versionId?: string): Promise<void>;
  setBotChannel(id: GameId, channel: 'stable' | 'development'): Promise<void>;
  checkBotUpdates(): Promise<void>;
  setUpdateChecks(enabled: boolean): Promise<void>;
  saveKey(id: GameId, key: string): Promise<void>;
  removeKey(id: GameId): Promise<void>;
  updatePlutonium(): Promise<boolean>;
  openKeyPage(): Promise<void>;
  openEngineGuide(id: GameId): Promise<void>;
  document(id: GameId, target: ConfigTarget, mode?: string): Promise<ConfigDocument>;
  previewSettings(id: GameId, target: ConfigTarget, mode: string, values: Record<string, string>, expectedPath?: string): Promise<ConfigPreview>;
  commitSettings(id: GameId, target: ConfigTarget, mode: string, values: Record<string, string>, token: string, expectedPath?: string): Promise<ConfigDocument>;
  artwork(id: GameId, kind: ArtworkKind): Promise<string | null>;
  firewallStatus(id: GameId): Promise<FirewallStatus>;
  firewallApply(id: GameId): Promise<FirewallStatus>;
  firewallRemove(id: GameId): Promise<FirewallStatus>;
  openDocs(id: GameId): Promise<void>;
  chooseArtwork(id: GameId, kind: 'hero' | 'cover'): Promise<boolean>;
  resetArtwork(id: GameId, kind: 'hero' | 'cover'): Promise<string | null>;
  openDocument(id: GameId, target: ConfigTarget, mode: string): Promise<boolean>;
  saveOptions(id: GameId, values: { port?: number; mode?: string; shuffle?: boolean; selectedMaps?: string[]; lan?: boolean }): Promise<void>;
  openConfig(id: GameId): Promise<boolean>;
  subscribe(listener: (event: ManagerEvent) => void): () => void;
}
declare global { interface Window { manager: ManagerApi } }
