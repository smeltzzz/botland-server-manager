const assert = require('node:assert/strict');
const { executeRenderer } = require('./smoke-harness.cjs');

async function waitForCondition(win, expression) {
  await executeRenderer(win, `new Promise((resolve, reject) => {
    let done = false;
    const timeout = setTimeout(() => { done = true; reject(new Error('Renderer condition timed out: ' + ${JSON.stringify(expression)})); }, 10000);
    const check = () => {
      if (done) return;
      if (window.__smokeNativeDialogs?.length) { done = true; clearTimeout(timeout); reject(new Error('Unexpected native dialog: ' + JSON.stringify(window.__smokeNativeDialogs))); return; }
      if (${expression}) { done = true; clearTimeout(timeout); resolve(); } else requestAnimationFrame(check);
    };
    check();
  })`);
}
async function layout(win, name, expectedWidth = null) {
  if (expectedWidth !== null) {
    // innerWidth is the CSS viewport; clientWidth can be 9 px smaller when
    // Chromium shows a vertical scrollbar. Still enforce overflow against the
    // smaller usable clientWidth below rather than hiding that reflow defect.
    try { await waitForCondition(win, `Math.abs(innerWidth - ${expectedWidth}) <= 1`); }
    catch (error) {
      if (error.code === 'RENDERER_UNRESPONSIVE' || /Unexpected native dialog:/.test(error.message)) throw error;
      const actual = await executeRenderer(win, '({ innerWidth, width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, devicePixelRatio })');
      throw new Error(`${name}: expected ${expectedWidth} CSS px, got ${JSON.stringify(actual)} (zoom ${win.webContents.getZoomFactor()}, content ${win.getContentSize().join('x')})`);
    }
  }
  await executeRenderer(win, `new Promise(resolve => {
    let previous = '', stable = 0;
    const check = () => {
      const key = [innerWidth, document.documentElement.clientWidth, document.documentElement.scrollWidth].join(':');
      stable = key === previous ? stable + 1 : 0;
      previous = key;
      if (stable >= 3) resolve(); else requestAnimationFrame(check);
    }; check();
  })`);
  const result = await executeRenderer(win, `(() => {
    const box = selector => { const rect = document.querySelector(selector)?.getBoundingClientRect(); return rect && { left: rect.left, right: rect.right, width: rect.width, top: rect.top, bottom: rect.bottom }; };
    const d = document.documentElement;
    const dialogs = [...document.querySelectorAll('dialog[open]')].map(dialog => { const r = dialog.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, scrollWidth: dialog.scrollWidth, width: dialog.clientWidth }; });
    const overflow = d.scrollWidth - d.clientWidth;
    const offenders = overflow > 1 ? [...document.querySelectorAll('body *')].map(element => {
      const rect = element.getBoundingClientRect();
      return { tag: element.tagName, className: typeof element.className === 'string' ? element.className : '', left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), text: (element.textContent || '').trim().slice(0, 65) };
    }).filter(item => item.width > 0 && (item.right > d.clientWidth + 1 || item.left < -1)).sort((a, b) => b.right - a.right).slice(0, 8) : [];
    const clippedControls = [...document.querySelectorAll('.topbar button, .card-open, .detail-hero-action button, .setup-wizard .primary-button, .restart-panel input, .config-savebar button, .console-actions button, dialog[open] button')].filter(element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden').map(element => {
      const r = element.getBoundingClientRect();
      return { tag: element.tagName, className: typeof element.className === 'string' ? element.className : '', left: r.left, right: r.right, name: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 65) };
    }).filter(control => control.left < -1 || control.right > d.clientWidth + 1);
    return { width: d.clientWidth, innerWidth, height: innerHeight, overflow,
      shell: box('.app-shell'), pane: box('.main-pane'), dialogs, offenders, clippedControls };
  })()`);
  assert.ok(result.overflow <= 1, `${name}: horizontal overflow ${JSON.stringify(result)}`);
  assert.deepEqual(result.clippedControls, [], `${name}: key controls must reflow, not be hidden by overflow clipping`);
  assert.ok(result.pane?.width > 0 && result.shell?.width <= result.width + 1, `${name}: collapsed layout ${JSON.stringify(result)}`);
  for (const dialog of result.dialogs) {
    assert.ok(dialog.left >= -1 && dialog.right <= result.width + 1 && dialog.top >= -1 && dialog.bottom <= result.height + 1,
      `${name}: dialog leaves the actual CSS viewport ${JSON.stringify({ dialog, viewport: result })}`);
    assert.ok(dialog.scrollWidth <= dialog.width + 1, `${name}: horizontally scrolling dialog ${JSON.stringify(dialog)}`);
  }
}
async function responsive(win, name, { full = true, onFailure = null } = {}) {
  async function measure(label, width) {
    try { await layout(win, label, width); }
    catch (error) { if (onFailure) onFailure(label, error); else throw error; }
  }
  for (const width of full ? [320, 400, 640, 900, 1100, 1380] : [320, 640]) {
    win.setContentSize(width, 850);
    await measure(`${name} ${width} CSS px`, width);
  }
  // Both passes really reach 320 CSS px; a large window at 200% alone never
  // exercised WCAG reflow. Content sizes avoid Windows' non-client borders.
  for (const zoom of full ? [2, 4] : [2]) {
    win.setContentSize(320 * zoom, 900);
    await measure(`${name} before ${zoom * 100}% zoom`, 320 * zoom);
    win.webContents.setZoomFactor(zoom);
    try { await measure(`${name} ${zoom * 100}% zoom at 320 CSS px`, 320); }
    finally { win.webContents.setZoomFactor(1); }
  }
  win.setContentSize(1380, 1000);
  await measure(`${name} reset`, 1380);
}
async function focusNotObscured(win, selector, name) {
  const result = await executeRenderer(win, `(async () => {
    const elements = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(element => !element.matches(':disabled'));
    const target = elements.at(-1);
    if (!target) return { missing: true };
    document.querySelector('.main-pane').scrollTop = 0;
    target.focus();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = target.getBoundingClientRect();
    const x = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const y = Math.min(innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    return { active: document.activeElement === target, unobscured: target === hit || target.contains(hit),
      rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
      viewport: { width: innerWidth, height: innerHeight }, target: target.outerHTML.slice(0, 220), blocker: hit?.outerHTML.slice(0, 220) };
  })()`);
  assert.equal(result.active, true, `${name}: keyboard focus target missing ${JSON.stringify(result)}`);
  assert.equal(result.unobscured, true, `${name}: sticky chrome obscures the focused control ${JSON.stringify(result)}`);
  assert.ok(result.rect.top >= -1 && result.rect.bottom <= result.viewport.height + 1 && result.rect.left >= -1 && result.rect.right <= result.viewport.width + 1,
    `${name}: focused control is outside the viewport ${JSON.stringify(result)}`);
}
function luminance(rgb) {
  const linear = rgb.map(value => { const s = value / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
async function artworkTextContrast(win, selector, name) {
  const sample = await executeRenderer(win, `(async () => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element.scrollIntoView({ block: 'center' });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const style = getComputedStyle(element);
    const r = element.getBoundingClientRect();
    const previous = element.style.visibility;
    const foreground = style.color.match(/[\\d.]+/g).map(Number);
    let opacity = 1; for (let node = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
    const threshold = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700) ? 3 : 4.5;
    element.style.visibility = 'hidden';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { previous, foreground, opacity, threshold, rect: { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), width: Math.max(1, Math.floor(Math.min(r.width, innerWidth - r.left))), height: Math.max(1, Math.floor(Math.min(r.height, innerHeight - r.top))) } };
  })()`);
  try {
    assert.ok(sample.foreground.length >= 3 && sample.foreground.slice(0, 3).every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 255)
      && Number.isFinite(sample.opacity) && sample.opacity >= 0 && sample.opacity <= 1, `${name}: invalid foreground/compositing data`);
    // Capture only in memory. No screenshot or private data is written anywhere.
    const image = await win.capturePage(sample.rect);
    const bytes = image.toBitmap();
    assert.ok(bytes.length > 0, `${name}: no composited artwork pixels were captured`);
    let worst = Infinity;
    let worstBackdrop = null;
    const alpha = (sample.foreground[3] ?? 1) * sample.opacity;
    for (let i = 0; i < bytes.length; i += 4) {
      const backdrop = [bytes[i + 2], bytes[i + 1], bytes[i]];
      const text = backdrop.map((value, channel) => sample.foreground[channel] * alpha + value * (1 - alpha));
      const a = luminance(backdrop), b = luminance(text);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < worst) { worst = ratio; worstBackdrop = backdrop; }
    }
    assert.ok(Number.isFinite(worst), `${name}: composited artwork contrast could not be measured`);
    assert.ok(worst >= sample.threshold - 0.05, `${name}: bright artwork backdrop contrast ${worst.toFixed(2)}:1 is below ${sample.threshold}:1 (text ${sample.foreground.join(',')}, background ${worstBackdrop?.join(',')})`);
  } finally { await executeRenderer(win, `document.querySelector(${JSON.stringify(selector)}).style.visibility = ${JSON.stringify(sample.previous)}`); }
}
module.exports = { waitForCondition, layout, responsive, focusNotObscured, artworkTextContrast };
