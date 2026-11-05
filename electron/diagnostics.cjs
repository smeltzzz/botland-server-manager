// A deliberately small allowlist. Do not add raw snapshot fields, logs, paths,
// addresses, process IDs, config contents, key status, or free-form messages.
const titles = [
  ['cod4', 'CoD4'], ['waw', 'WaW'], ['mw2', 'MW2'],
  ['bo1', 'BO1'], ['mw3', 'MW3'], ['bo2', 'BO2'],
];
const statuses = new Set(['stopped', 'starting', 'running', 'stopping', 'restarting']);

/** @param {unknown} value */
function count(value) {
  return Array.isArray(value) ? Math.min(value.length, 999) : 0;
}

/** @param {unknown} snapshot @param {string} version @param {string} platform @param {string} arch */
function formatDiagnostics(snapshot, version, platform, arch) {
  // Version/platform/arch come from Electron and Node, never from the renderer.
  const lines = [`botLANd diagnostics`, `App version: ${version}`, `Platform: ${platform} ${arch}`, 'Game readiness:'];
  const games = snapshot && typeof snapshot === 'object' && Array.isArray(snapshot.games) ? snapshot.games : [];
  for (const [id, title] of titles) {
    const game = games.find(item => item && typeof item === 'object' && item.id === id);
    const installed = game?.installed === true ? 'yes' : 'no';
    const status = statuses.has(game?.status) ? game.status : 'unknown';
    lines.push(`${title}: installed=${installed}; status=${status}; blockers=${count(game?.blockers)}; warnings=${count(game?.warnings)}`);
  }
  lines.push('No paths, addresses, logs, keys, configuration values, or server output are included.');
  return lines.join('\n');
}

module.exports = { formatDiagnostics };
