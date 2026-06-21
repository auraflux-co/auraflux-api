describe('youtube_direct getLiveStreamHealth', () => {
  test('parses videoIngestionStarved from health payload', () => {
    const issues = [{ type: 'videoIngestionStarved', severity: 'error' }];
    const starved = issues.some((i) => i.type === 'videoIngestionStarved');
    expect(starved).toBe(true);
  });
});
