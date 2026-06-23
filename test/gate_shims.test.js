'use strict';
/**
 * CPD-1022 — gate shim registry: assembly must resolve gate modules without portal rename crashes.
 */

const fs = require('fs');
const path = require('path');

describe('C0 gate shims', () => {
  const gatesDir = path.join(__dirname, '..', 'lib', 'gates');

  test('gate1/2/3b shims exist and re-export portal workers', () => {
    for (const gate of ['gate1', 'gate2', 'gate3b']) {
      const shim = path.join(gatesDir, `${gate}.js`);
      expect(fs.existsSync(shim)).toBe(true);
      const mod = require(`../lib/gates/${gate}`);
      expect(typeof mod.run).toBe('function');
    }
  });

  test('gate5 is full C0 publish module (not portal5 one-liner)', () => {
    const src = fs.readFileSync(path.join(gatesDir, 'gate5.js'), 'utf8');
    expect(src).toContain('uploadposts/status');
    expect(src).not.toMatch(/require\(['"]\.\.\/portals\/portal5['"]\)/);
  });

  test('assembly still requires gate3b path', () => {
    const asm = fs.readFileSync(path.join(__dirname, '..', 'lib', 'assembly.js'), 'utf8');
    expect(asm).toMatch(/gates\/gate3b|require\(['"]\.\/gates\/gate3b['"]\)/);
  });
});
