'use strict';
/** Live QA harness for Render hub tickets (local module checks — not a substitute for app browse). */

const { resolveActivePortals, resolveActiveExtensions } = require('../lib/job_spec');
const { assertPublishReadiness } = require('../lib/services/approve_publish');
const { productionCronDefault } = require('../lib/services/production_cron');
const { isLongformAvatarBlocked } = require('../lib/calendar/auto_production');

let pass = 0;
let fail = 0;

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// CPD-1043/1044/1046 staging clip job
{
  const spec = {
    contentType: 'clips',
    templateName: 'TikTok Clutch',
    staging: true,
    stageMap: { script: { active: false } },
  };
  const active = resolveActivePortals(spec);
  ok('CPD-1043/1046 staging clip portals', active.join(',') === 'portal0,portal3a,portal3b,portal4', active.join(','));
  ok('CPD-1044 portal5 off when staging', spec.portals.portal5.active === false);
  ok('CPD-1046 portal4 on for clips', spec.portals.portal4.active === true);
}

// CPD-1043 non-staging enables portal5
{
  const spec = { contentType: 'clips', templateName: 'TikTok Clutch', staging: false, stageMap: { script: { active: false } } };
  const active = resolveActivePortals(spec);
  ok('CPD-1043 portal5 on when not staging', spec.portals.portal5.active === true);
  ok('CPD-1046 portal4 still on when not staging', active.includes('portal4'));
}

// CPD-1045 blocks bad pixels / missing features
{
  const bad = assertPublishReadiness({
    status: 'complete',
    grade: 100,
    brandId: 'test-brand',
    state: { chromeApplied: false },
    processingManifest: { featuresOrdered: ['captions'], featuresApplied: [] },
  });
  ok('CPD-1045 blocks chromeApplied false', !bad.ok && bad.errors.some((e) => e.includes('chromeApplied')));
}

{
  const lowGrade = assertPublishReadiness({ status: 'complete', grade: 60, state: { chromeApplied: true } });
  ok('CPD-1045 blocks grade below 75', !lowGrade.ok);
}

// CPD-1045 allows good job + clip path chrome skip
{
  const good = assertPublishReadiness({
    status: 'complete',
    grade: 90,
    gradeResult: { passed: true },
    state: { chromeApplied: true },
    processingManifest: { featuresOrdered: ['captions'], featuresApplied: ['captions'] },
  });
  ok('CPD-1045 passes good spec', good.ok, good.errors.join('; '));

  const clip = assertPublishReadiness({
    status: 'complete',
    grade: 90,
    productionPath: 'short_compile_clips',
    state: { chromeApplied: false, chromeSkipped: true },
  });
  ok('CPD-1045 clip path chromeSkipped OK', clip.ok);
}

// CPD-1045 extension map
{
  const ext = resolveActiveExtensions({ addOns: { heygen: { active: true } } });
  ok('resolveActiveExtensions heygen', ext.includes('heygen_ext'));
}

// CPD-1053 production cron default safe on Render
{
  const prev = process.env.RENDER;
  process.env.RENDER = 'true';
  delete process.env.PRODUCTION_CRON;
  ok('CPD-1053 Render default cron off', productionCronDefault() === 'off');
  process.env.PRODUCTION_CRON = 'on';
  ok('CPD-1053 explicit PRODUCTION_CRON=on', productionCronDefault() === 'on');
  if (prev === undefined) delete process.env.RENDER;
  else process.env.RENDER = prev;
}

// CPD-1053 longform gate helper loads
{
  const block = isLongformAvatarBlocked();
  ok('CPD-1053 isLongformAvatarBlocked returns shape', typeof block.blocked === 'boolean');
}

console.log(`\nRender hub QA: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
