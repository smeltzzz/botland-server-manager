// Collects every t('...') / tp('...', '...') key in the renderer. Used by the
// extraction script and by the i18n test, so a missing catalog entry fails CI.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function sourceFiles(root) {
  const files = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // The i18n runtime translates keys dynamically; only application code
      // contributes catalog entries.
      if (entry.isDirectory() && path.normalize(full) !== path.normalize(path.join(root, 'i18n'))) walk(full);
      else if (!entry.isDirectory() && /\.tsx?$/.test(entry.name)) files.push(full);
    }
  };
  walk(root);
  return files;
}

function collectKeys(root) {
  const keys = new Map();
  const problems = [];
  for (const file of sourceFiles(root)) {
    const text = fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
    const lineOf = pos => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        if (name === 't' || name === 'tp') {
          const args = name === 't' ? [node.arguments[0]] : [node.arguments[0], node.arguments[1]];
          for (const arg of args) {
            if (!arg) continue;
            if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
              const key = arg.text;
              if (!keys.has(key)) keys.set(key, { file: path.relative(root, file), line: lineOf(arg.getStart()) });
            } else {
              problems.push(`${path.relative(root, file)}:${lineOf(arg.getStart())} uses ${name}() with a non-literal key`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { keys, problems };
}

// Strings translated through a runtime lookup rather than a literal t('...').
// Keep this list small; prefer a literal t() call wherever the key is fixed.
const dynamicKeys = [
  'The saved key file (keys.json) is damaged. Click Reset key storage, then paste the key again.',
  'Windows encryption is unavailable for this user, so the key cannot be stored securely.',
  'Secure key storage is unavailable.', 'Stored server keys are unavailable.',
  'Could not encrypt server key.', 'Invalid server key.',
  'Key storage was not damaged, so nothing was changed.',
  'Up to date with the latest check', 'Checked; no upstream change', 'Checked recently',
  'Could not reach GitHub; retrying later', 'GitHub rate limit reached; retrying later',
  'No verified upstream release', 'Update checks are off',
  'Waiting for the firewall change', 'Saving launch options', 'Saving visibility', 'Refreshing status',
  'Scanning installations', 'Scanning processes', 'Choosing a game folder', 'Updating Plutonium',
  'Checking for updates', 'Saving the update setting', 'Saving automatic restart', 'Updating artwork',
  'Saving the server key', 'Resetting key storage', 'Removing the server key', 'Creating the server config',
  'Copying diagnostics', 'Copying the address', 'Opening the setup guide', 'Opening the key page',
  'Opening the config', 'Saving the release channel', 'Starting a server',
  'Installing or updating engine files', 'Changing Bot Warfare files', 'Working',
  'Overview', 'Configuration', 'Maps & modes', 'Console',
  'installed', 'updated', 'reinstalled', 'removed', 'stable', 'development', 'header', 'card',
  'PUBLIC', 'enabled', 'disabled', 'Server', 'Update', 'Install', 'Updating', 'public',
  'unidentified process', 'in your Steam library', 'in the folder you chose',
  'from your local network only', 'from any address',
  'The running server keeps its current visibility until restarted.', 'Takes effect at the next start.',
];

module.exports = { collectKeys, sourceFiles, dynamicKeys };
