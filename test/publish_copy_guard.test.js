'use strict';

const { rejectGenericGamingPublishCopy } = require('../lib/publish');

describe('rejectGenericGamingPublishCopy — CPD-1013', () => {
  test('rejects generic tech-world title for clips content', () => {
    expect(() =>
      rejectGenericGamingPublishCopy(
        {
          youtube: {
            title: 'Breaking developments in the tech world',
            description: 'Tonight update on infrastructure.',
          },
        },
        {
          contentType: 'clips',
          scriptExcerpt: 'Streamer hits a clutch play in Valorant.',
          items: [{ title: 'tenshi' }],
        }
      )
    ).toThrow(/Rejected generic/);
  });

  test('allows grounded gaming title with streamer name', () => {
    expect(() =>
      rejectGenericGamingPublishCopy(
        {
          youtube: {
            title: "Tenshi's Insane Valorant Clutch",
            description: 'Watch the full highlight from tenshi stream.',
          },
        },
        {
          contentType: 'clips',
          scriptExcerpt: 'Tenshi clutches a 1v3 in Valorant on Ascent.',
          items: [{ title: 'tenshi' }],
        }
      )
    ).not.toThrow();
  });

  test('rejects when script excerpt is placeholder-only', () => {
    expect(() =>
      rejectGenericGamingPublishCopy(
        { youtube: { title: 'Some title', description: 'desc' } },
        {
          contentType: 'clips',
          scriptExcerpt: 'Video clip 1 for "Gaming Highlights"',
          items: [],
        }
      )
    ).toThrow(/placeholder-only/);
  });

  test('no-op for news content type', () => {
    expect(() =>
      rejectGenericGamingPublishCopy(
        {
          youtube: {
            title: 'Breaking developments in the tech world',
            description: 'Wire copy.',
          },
        },
        {
          contentType: 'news',
          scriptExcerpt: 'President announces policy shift.',
          items: [],
        }
      )
    ).not.toThrow();
  });
});
