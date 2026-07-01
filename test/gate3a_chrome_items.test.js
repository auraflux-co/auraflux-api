'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveGate3aExpectedChromeItems,
  formatGate3aExpectedChromeItems,
  isTwitchLongForm,
} = require('../lib/gate3a_chrome_items');

describe('gate3a chrome items', () => {
  it('Twitch long-form uses sceneStructure labels not clip titles', () => {
    const jobSpec = {
      contentType: 'twitch',
      designSpec: {
        sceneStructure: {
          items: [
            { label: 'Cinna', data: { matchup: 'cinna crashing out' } },
            { label: 'Emily', data: { matchup: 'ICANT' } },
          ],
        },
      },
      order: {
        inputs: {
          items: [
            { title: 'cinna crashing out' },
            { title: 'ICANT' },
          ],
        },
      },
    };
    assert.equal(isTwitchLongForm(jobSpec), true);
    const rows = resolveGate3aExpectedChromeItems(jobSpec);
    assert.deepEqual(rows.map((r) => r.title), ['Cinna', 'Emily']);
    assert.match(formatGate3aExpectedChromeItems(jobSpec), /1\. Cinna.*2\. Emily/);
  });

  it('news still uses order.inputs titles', () => {
    const jobSpec = {
      contentType: 'news',
      order: { inputs: { items: [{ title: 'Headline A' }] } },
    };
    assert.equal(isTwitchLongForm(jobSpec), false);
    assert.equal(resolveGate3aExpectedChromeItems(jobSpec)[0].title, 'Headline A');
  });
});
