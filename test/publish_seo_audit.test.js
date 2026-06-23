'use strict';

const {
  snapshotFromPublishCopy,
  snapshotFromGateMetadata,
  recordPublishCopySnapshot,
  recordGateMetadataSnapshot,
  diffSnapshots,
} = require('../lib/publish_seo_audit');

describe('publish_seo_audit', () => {
  test('snapshotFromPublishCopy captures title and counts', () => {
    const snap = snapshotFromPublishCopy({
      youtube: {
        bestTitle: { title: 'ExtraEmily loses it in NYC' },
        description: 'Subscribe for more #Shorts #TwitchClips #ExtraEmily',
        tags: ['twitch', 'clips', 'funny'],
      },
      tiktok: { caption: 'ExtraEmily moment #FYP #TwitchClips' },
    }, 'generated');
    expect(snap.stage).toBe('generated');
    expect(snap.youtube.title).toBe('ExtraEmily loses it in NYC');
    expect(snap.youtube.tagCount).toBe(3);
    expect(snap.youtube.descriptionHashtags).toBeGreaterThanOrEqual(3);
  });

  test('recordPublishCopySnapshot appends changes between stages', () => {
    let audit = recordPublishCopySnapshot(null, {
      youtube: { title: 'Title A', description: 'word '.repeat(130), tags: ['a', 'b'] },
      tiktok: { caption: 'short caption #FYP #Twitch' },
    }, 'generated');
    audit = recordGateMetadataSnapshot(audit, {
      title: 'Title B',
      description: 'word '.repeat(140),
      tags: ['a', 'b', 'c'],
      tiktokCaption: 'longer caption #FYP #Twitch #ExtraEmily',
    }, 'gate5_upload');
    expect(audit.snapshots.length).toBe(2);
    expect(audit.lastChanges.some((c) => c.includes('YT title'))).toBe(true);
  });

  test('diffSnapshots detects tag count change', () => {
    const prev = snapshotFromGateMetadata({ title: 'X', tags: ['a'] });
    const next = snapshotFromGateMetadata({ title: 'X', tags: ['a', 'b', 'c'] });
    const changes = diffSnapshots(prev, next);
    expect(changes.some((c) => c.includes('YT tags'))).toBe(true);
  });
});
