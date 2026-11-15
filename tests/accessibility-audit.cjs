// No opacity/disabled exclusions: semantic rules apply to every exposed
// control, and opacity does not make an enabled control inactive. Axe already
// implements WCAG's inactive-control colour-contrast exception. Only explicitly
// aria-hidden, noninteractive decorative art is outside the audit context.
const assert = require('node:assert/strict');
const { executeRenderer } = require('./smoke-harness.cjs');

async function settleDom(win) {
  await executeRenderer(win, `new Promise((resolve, reject) => {
    let quiet;
    const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(finish, 400); });
    const limit = setTimeout(() => { observer.disconnect(); clearTimeout(quiet); reject(new Error('Accessibility DOM never settled')); }, 10000);
    const finish = () => { observer.disconnect(); clearTimeout(quiet); clearTimeout(limit); resolve(); };
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    quiet = setTimeout(finish, 400);
  })`);
}
async function runAxe(win, contextSelector = null) {
  return executeRenderer(win, `(() => {
    const interactive = 'button, input, select, textarea, a[href], [tabindex], [contenteditable], [role]';
    const decorations = ['.intro-mark[aria-hidden="true"]', '.detail-hero-art[aria-hidden="true"]',
      '.card-art-number[aria-hidden="true"]', '.card-art-code[aria-hidden="true"]'].filter(selector => {
      const elements = [...document.querySelectorAll(selector)];
      return elements.length > 0 && elements.every(element => !element.matches(interactive) && !element.querySelector(interactive));
    });
    return axe.run(${contextSelector ? `document.querySelector(${JSON.stringify(contextSelector)})` : '{ exclude: decorations }'}, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] }
    }).then(result => ({ violations: result.violations.map(item => ({
    id: item.id, impact: item.impact, help: item.help,
    nodes: item.nodes.map(node => {
      const selector = node.target;
      let element = null;
      try { element = document.querySelector(Array.isArray(selector) ? selector.join(' ') : selector); } catch { /* Preserve unresolved targets as failures too. */ }
      const style = element ? getComputedStyle(element) : null;
      return { target: selector, summary: node.failureSummary, html: node.html,
        disabled: Boolean(element && (element.matches(':disabled') || element.closest('[aria-disabled="true"]'))),
        opacity: style ? Number(style.opacity) : 1 };
    })
    })), incomplete: result.incomplete.length }));
  })()`);
}
async function ensureAxe(win, axeSource) {
  // Route changes stay in one document. Reuse axe's supported repeated-run API
  // instead of installing dozens of retained copies during the full matrix.
  if (!await executeRenderer(win, "typeof window.axe?.run === 'function'")) await executeRenderer(win, axeSource);
}
async function settledAxe(win, axeSource) {
  await executeRenderer(win, 'document.fonts.ready');
  await settleDom(win);
  await ensureAxe(win, axeSource);
  let result = await runAxe(win);
  for (let attempt = 0; attempt < 3; attempt++) {
    await settleDom(win);
    const next = await runAxe(win);
    if (JSON.stringify(next.violations) === JSON.stringify(result.violations)) return next;
    result = next;
  }
  throw new Error(`Accessibility violations did not stabilize: ${JSON.stringify(result.violations)}`);
}
async function verifyAuditSelfCheck(win, axeSource) {
  await executeRenderer(win, `(() => {
    const fixture = document.createElement('section');
    fixture.id = 'audit-self-check';
    fixture.setAttribute('aria-label', 'Audit regression fixture');
    fixture.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:white;color:black;padding:20px';
    // Inline style attributes in HTML strings are blocked by the CSP (no
    // 'unsafe-inline' in style-src); CSSOM style assignments are allowed.
    fixture.innerHTML = '<button id="audit-opacity"></button>'
      + '<button id="audit-contrast">Contrast regression</button>'
      + '<div id="audit-semantic" role="checkbox" aria-disabled="true" aria-label="Missing required state" tabindex="0">Missing state</div>';
    fixture.querySelector('#audit-opacity').style.cssText = 'opacity:.88;min-width:44px;min-height:44px';
    fixture.querySelector('#audit-contrast').style.cssText = 'opacity:.88;background:#fff;color:#bbb;font:16px Arial';
    document.body.append(fixture);
  })()`);
  try {
    await executeRenderer(win, axeSource);
    const result = await runAxe(win, '#audit-self-check');
    const has = (rule, selector) => result.violations.some(item => item.id === rule && item.nodes.some(node => node.target.includes(selector)));
    assert.ok(has('button-name', '#audit-opacity'), 'A nameless ENABLED opacity .88 control must remain an enforced failure');
    assert.ok(has('color-contrast', '#audit-contrast'), 'Enabled reduced-opacity low-contrast text must remain an enforced failure');
    assert.ok(has('aria-required-attr', '#audit-semantic'), 'Disabled controls must not be globally excluded from semantic rules');
    console.log('Accessibility audit self-check: enabled opacity .88 name/contrast and disabled semantic violations were retained.');
  } finally { await executeRenderer(win, "document.querySelector('#audit-self-check')?.remove()"); }
}
module.exports = { settleDom, runAxe, settledAxe, verifyAuditSelfCheck };
