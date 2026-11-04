const test = require('node:test');
const assert = require('node:assert/strict');
const { fieldFor } = require('../electron/schema.cjs');
const { validateValues } = require('../electron/config.cjs');

test('MW2, MW3 and BO2 cap both player slots and bot fill at 18', () => {
  for (const id of ['mw2', 'mw3', 'bo2']) {
    const opts = { id, target: 'base', mode: 'dom' };
    assert.equal(fieldFor(id, 'base', 'sv_maxclients').max, 18);
    assert.equal(fieldFor(id, 'base', 'bots_manage_fill').max, 18);
    assert.throws(() => validateValues({ sv_maxclients: '19' }, opts, 'set sv_maxclients "18"\n'), /18|player slots/i);
    assert.throws(() => validateValues({ bots_manage_fill: '19' }, opts, ''), /18|player slots/i);
    assert.deepEqual(validateValues({ sv_maxclients: '18', bots_manage_fill: '12' }, opts, 'set sv_maxclients "18"\n'), { sv_maxclients: '18', bots_manage_fill: '12' });
  }
  for (const id of ['cod4', 'waw', 'bo1']) {
    assert.equal(fieldFor(id, 'base', 'sv_maxclients').max, 64);
  }
});
