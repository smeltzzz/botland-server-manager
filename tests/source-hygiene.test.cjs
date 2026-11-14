// Guards against editor/scripting artifacts that end up as visible text.
// A PowerShell replacement once inserted a literal `r`n into JSX, and the
// Dashboard rendered those characters between two sections.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.join(__dirname, '..', 'src');

async function sources(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sources(full));
    else if (/\.(?:ts|tsx|css|json)$/.test(entry.name)) files.push(full);
  }
  return files;
}

test('renderer sources contain no shell-escape artifacts', async () => {
  const files = await sources(root);
  const offenders = [];
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    // Backtick-r/backtick-n outside a template literal's escape syntax is an
    // artifact: CSS/TS never needs a bare `r or `n sequence.
    text.split(/\r?\n/).forEach((line, index) => {
      if (/`[rn]`[rn]/.test(line)) offenders.push(`${path.relative(root, file)}:${index + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(offenders, []);
});
