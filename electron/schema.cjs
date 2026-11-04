// Game-specific, persistent settings documented by the Bot Warfare repositories.
// An absent setting uses the mod/engine default until the user explicitly edits it.
const all = ['cod4', 'waw', 'mw2', 'bo1', 'mw3', 'bo2'];
const extended = ['cod4', 'waw', 'mw2', 'mw3'];
const notT6 = ['cod4', 'waw', 'mw2', 'bo1', 'mw3'];
const toggle = [{ value: '0', label: 'Off' }, { value: '1', label: 'On' }];
const choice = (values) => values.map(([value, label]) => ({ value, label }));
const fillExtended = choice([['0', 'Players + bots'], ['1', 'Bots only'], ['2', 'Players + bots, adjust to map'], ['3', 'Bots only, adjust to map'], ['4', 'Balance teams'], ['5', 'Balance teams, adjust to map']]);
const fillT6 = fillExtended.slice(0, 2);
const team = choice([['autoassign', 'Auto-assign'], ['allies', 'Allies'], ['axis', 'Axis'], ['spectator', 'Spectator'], ['custom', 'Custom split']]);
const f = (key, section, label, type, extra = {}) => ({ key: key.toLowerCase(), sourceKey: key, section, label, type, ...extra });
const B = 'Bot population', T = 'Teams & balance', D = 'Difficulty', L = 'Loadouts', P = 'Bot behavior', H = 'Host & diagnostics', S = 'Server & access', R = 'Match rules';
const botFields = [
  f('bots_main', B, 'Enable Bot Warfare', 'select', { games: all, choices: toggle, default: '1' }),
  f('bots_main_waitForHostTime', H, 'Wait for host (seconds)', 'integer', { games: all, min: 0, max: 300, default: '10' }),
  f('bots_main_kickBotsAtEnd', B, 'Remove bots after each match', 'select', { games: all, choices: toggle, default: '0' }),
  f('bots_manage_fill', B, 'Fill target', 'integer', { games: all, min: 0, max: 64, default: '0', hint: 'Players and bots to maintain; counting depends on Fill mode.' }),
  f('bots_manage_fill_mode', B, 'Fill mode', 'select', { games: notT6, choices: fillExtended, default: '0' }),
  f('bots_manage_fill_mode', B, 'Fill mode', 'select', { games: ['bo2'], choices: fillT6, default: '0' }),
  f('bots_manage_fill_kick', B, 'Remove excess bots', 'select', { games: all, choices: toggle, default: '0' }),
  f('bots_manage_fill_spec', B, 'Count spectators', 'select', { games: all, choices: toggle, default: '1' }),
  f('bots_manage_fill_watchplayers', B, 'Wait for a human player', 'select', { games: notT6, choices: toggle, default: '0' }),
  f('bots_team', T, 'Bot team', 'select', { games: all, choices: team, default: 'autoassign' }),
  f('bots_team_amount', T, 'Axis bots in custom split', 'integer', { games: all, min: 0, max: 64, default: '0', dependsOn: { key: 'bots_team', value: 'custom' } }),
  f('bots_team_force', T, 'Force team assignment', 'select', { games: all, choices: toggle, default: '0' }),
  f('bots_team_mode', T, 'Team count method', 'select', { games: all, choices: choice([['0', 'Players + bots'], ['1', 'Bots only']]), default: '0' }),
  f('bots_skill', D, 'Bot skill', 'select', { games: extended, choices: choice([['0', 'Random'], ['1', 'Easiest'], ['2', 'Easy'], ['3', 'Moderate'], ['4', 'Normal'], ['5', 'Challenging'], ['6', 'Hard'], ['7', 'Hardest'], ['8', 'Custom team mix'], ['9', 'Fully randomized']]), default: '0' }),
  f('bots_skill', D, 'Bot skill', 'select', { games: ['bo2'], choices: choice([['0', 'Easy'], ['1', 'Normal'], ['2', 'Hard'], ['3', 'Hardest']]), default: '0', hint: 'Black Ops II uses its own 0–3 scale.' }),
  f('bot_difficulty', D, 'Native bot difficulty', 'select', { games: ['bo1'], choices: choice([['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard'], ['veteran', 'Veteran']]), default: 'normal', hint: 'Black Ops native difficulty; not a T5 Bot Warfare DVAR.' }),
  ...['axis_hard', 'axis_med', 'allies_hard', 'allies_med'].map(name => f(`bots_skill_${name}`, D, `${name.replaceAll('_', ' ')} bots`, 'integer', { games: extended, min: 0, max: 64, default: '0', dependsOn: { key: 'bots_skill', value: '8' } })),
  f('bots_skill_min', D, 'Minimum bot skill', 'integer', { games: extended, min: 1, max: 7, default: '1' }),
  f('bots_skill_max', D, 'Maximum bot skill', 'integer', { games: extended, min: 1, max: 7, default: '7' }),
  f('bots_loadout_rank', L, 'Bot rank', 'integer', { games: all, min: -1, max: 80, default: '-1', hint: '-1 average player rank; 0 randomized.' }),
  f('bots_loadout_prestige', L, 'Bot prestige', 'integer', { games: ['waw', 'mw2', 'bo1', 'mw3', 'bo2'], min: -2, max: 20, default: '-1', hint: '-1 host prestige; -2 randomized.' }),
  f('bots_loadout_codpoints', L, 'Bot CoD points', 'integer', { games: ['bo1'], min: -1, max: 1000000, default: '-1' }),
  f('bots_loadout_reasonable', L, 'Prefer reasonable loadouts', 'select', { games: notT6, choices: toggle, default: '0' }),
  f('bots_loadout_allow_op', L, 'Allow powerful loadouts', 'select', { games: notT6, choices: toggle, default: '1' }),
  ...['move', 'knife', 'fire', 'nade', 'obj', 'camp', 'target_other', 'killstreak', 'ads', 'aim', 'jumpdrop', 'take_carepackages'].map(name => {
    const support = name === 'nade' || name === 'aim' ? all : name === 'jumpdrop' ? [...extended, 'bo2'] : name === 'take_carepackages' ? ['mw2', 'mw3', 'bo1'] : name === 'ads' ? extended : notT6;
    return f(`bots_play_${name}`, P, `Bots can ${name.replaceAll('_', ' ')}`, 'select', { games: support, choices: toggle, default: '1' });
  }),
  f('bots_main_firstIsHost', H, 'First player gets host controls', 'select', { games: ['cod4'], choices: toggle, default: '1', hint: 'IW3 upstream defaults this on. Disable it on public servers.' }),
  f('bots_main_firstIsHost', H, 'First player gets host controls', 'select', { games: ['waw', 'mw2', 'mw3'], choices: toggle, default: '0', hint: 'Disable it on public servers.' }),
  f('bots_main_menu', H, 'In-game bot menu', 'select', { games: extended, choices: toggle, default: '1' }),
  f('bots_main_debug', H, 'Bot diagnostics', 'select', { games: notT6, choices: choice([['0', 'Off'], ['1', 'Events'], ['2', 'Verbose']]), default: '0' }),
  f('bots_main_chat', H, 'Bot chat rate', 'decimal', { games: extended, min: 0, max: 10, default: '1.0' }),
];
const serverFields = [
  f('sv_hostname', S, 'Server name', 'text', { games: all, maxLength: 80, presentOnly: true }),
  f('sv_maxclients', S, 'Player slots', 'integer', { games: all, min: 2, max: 64, presentOnly: true }),
  f('sv_privateclients', S, 'Reserved slots', 'integer', { games: all, min: 0, max: 64, presentOnly: true }),
  f('sv_maxping', S, 'Maximum ping', 'integer', { games: all, min: 0, max: 1000, presentOnly: true }),
  f('sv_voice', S, 'Voice chat', 'select', { games: all, choices: toggle, presentOnly: true }),
  f('sv_motd', S, 'Message of the day', 'text', { games: all, maxLength: 200, presentOnly: true, allowEmpty: true }),
  f('g_allowvote', S, 'Allow voting', 'select', { games: all, choices: toggle, presentOnly: true }),
  f('sv_pure', S, 'Pure server', 'select', { games: all, choices: toggle, presentOnly: true }),
  f('scr_teambalance', R, 'Team balance', 'select', { games: all, choices: toggle, presentOnly: true }),
  f('scr_hardcore', R, 'Hardcore', 'select', { games: all, choices: toggle, presentOnly: true }),
  f('scr_team_fftype', R, 'Friendly fire', 'select', { games: all, choices: choice([['0', 'Off'], ['1', 'On'], ['2', 'Reflect'], ['3', 'Shared']]), presentOnly: true }),
  f('scr_game_allowkillcam', R, 'Killcam', 'select', { games: all, choices: toggle, presentOnly: true }),
  f('scr_game_hardpoints', R, 'Killstreak rewards', 'select', { games: all, choices: toggle, presentOnly: true }),
  f('scr_game_perks', R, 'Perks', 'select', { games: all, choices: toggle, presentOnly: true }),
  f('scr_player_healthregentime', R, 'Health regeneration time', 'integer', { games: all, min: 0, max: 120, presentOnly: true }),
  f('scr_player_maxhealth', R, 'Player health', 'integer', { games: all, min: 1, max: 500, presentOnly: true }),
  f('g_inactivity', S, 'Idle kick delay', 'integer', { games: all, min: 0, max: 3600, presentOnly: true }),
];
const mw3Rules = [
  f('commonOption.timeLimit', R, 'Time limit (minutes)', 'decimal', { min: 0, max: 30 }),
  f('commonOption.scoreLimit', R, 'Score limit', 'select', { choices: [0, 1, 3, 4, 5, 8, 10, 12, 15, 20, 24, 30, 50, 65, 80, 100, 200, 250, 500, 750, 1000, 1500, 2500, 3000, 5000, 7000, 7500, 10000, 15000, 20000, 30000].map(value => ({ value: String(value), label: String(value) })) }),
  f('commonOption.roundLimit', R, 'Round limit', 'integer', { min: 0, max: 100, presentOnly: true }),
  f('commonOption.friendlyFire', R, 'Friendly fire', 'select', { choices: toggle }),
  f('commonOption.hardcoreModeOn', R, 'Hardcore', 'select', { choices: toggle }),
  f('commonOption.allowKillstreaks', R, 'Killstreaks', 'select', { choices: toggle }),
  f('commonOption.allowPerks', R, 'Perks', 'select', { choices: toggle }),
  f('commonOption.allowCustomClasses', R, 'Custom classes', 'select', { choices: toggle }),
  f('commonOption.forceRespawn', R, 'Force respawn', 'select', { choices: toggle }),
  f('commonOption.radarAlwaysOn', R, 'Always-on radar', 'select', { choices: toggle }),
];
const bo2Rules = [
  f('timelimit', R, 'Time limit (minutes)', 'integer', { min: 0, max: 120 }),
  f('scorelimit', R, 'Score limit', 'integer', { min: 0, max: 30000 }),
  f('roundLimit', R, 'Round limit', 'integer', { min: 0, max: 100 }),
  f('autoTeamBalance', R, 'Auto team balance', 'select', { choices: toggle }),
  f('allowFinalKillcam', R, 'Final killcam', 'select', { choices: toggle }),
  f('hardcoreMode', R, 'Hardcore', 'select', { choices: toggle }),
  f('friendlyfiretype', R, 'Friendly fire', 'select', { choices: choice([['0', 'Off'], ['1', 'On'], ['2', 'Reflect'], ['3', 'Shared']]) }),
  f('allowSpectating', R, 'Spectating', 'select', { choices: toggle }),
  f('playerMaxHealth', R, 'Player health (%)', 'integer', { min: 1, max: 200 }),
  f('loadoutKillstreaksEnabled', R, 'Killstreaks', 'select', { choices: toggle }),
];
/** @param {string} id @param {'base'|'mode'} [target] @param {string} [mode] */
function schemaFor(id, target = 'base', mode = 'dom') {
  if (!all.includes(id)) throw new Error('Unknown game.');
  if (target === 'mode') {
    if (id === 'mw3') return { dialect: 'gameOpt', fields: mw3Rules };
    if (id === 'bo2') return { dialect: 'gts', fields: bo2Rules };
    throw new Error('This game stores its rules in the server config.');
  }
  if (target !== 'base') throw new Error('Unknown config section.');
  const modeRules = [
    ['timelimit', 'Time limit', 120], ['scorelimit', 'Score limit', 30000],
    ['roundlimit', 'Round limit', 100], ['numlives', 'Lives per player', 100],
    ['playerrespawndelay', 'Respawn delay', 120], ['waverespawndelay', 'Wave respawn delay', 120],
  ];
  const rules = modeRules.map(([name, label, max]) => f(`scr_${mode}_${name}`, R, `${label} for ${mode.toUpperCase()}`, 'integer', { min: 0, max, presentOnly: true }));
  const slotCap = ['mw2', 'mw3', 'bo2'].includes(id) ? 18 : 64;
  const fields = [...serverFields, ...botFields.filter(field => field.games.includes(id)), ...(id === 'mw3' || id === 'bo2' ? [] : rules)]
    .map(field => ['sv_maxclients', 'bots_manage_fill'].includes(field.key) ? { ...field, max: slotCap } : field);
  return { dialect: 'dvar', fields };
}
function fieldFor(id, target, key, mode) { return schemaFor(id, target, mode).fields.find(field => field.key === key.toLowerCase()); }
const sourceRepos = { cod4: 'https://github.com/ineedbots/iw3_bot_warfare', waw: 'https://github.com/ineedbots/t4_bot_warfare', mw2: 'https://github.com/ineedbots/iw4_bot_warfare', bo1: 'https://github.com/ineedbots/t5_bot_warfare', mw3: 'https://github.com/ineedbots/iw5_bot_warfare', bo2: 'https://github.com/ineedbots/t6_bot_warfare' };
module.exports = { schemaFor, fieldFor, sourceRepos };
