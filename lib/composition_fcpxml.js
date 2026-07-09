'use strict';

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Minimal FCPXML 1.9 export for clip comps (one storyline, trimmed assets).
 */
function buildFcpxml({ title = 'AuraFlux Export', clips = [], fps = 30, width = 1080, height = 1920 } = {}) {
  const frameDuration = `1/${fps}s`;
  let offsetFrames = 0;
  const resources = [];
  const spine = [];

  clips.forEach((clip, i) => {
    const id = `r${i + 1}`;
    const durSec = Math.max(0.5, (clip.trimEnd != null ? clip.trimEnd : clip.duration || 30)
      - (clip.trimStart || 0));
    const durFrames = Math.max(1, Math.round(durSec * fps));
    const name = escapeXml(clip.title || clip.displayName || `Clip ${i + 1}`);
    const src = escapeXml(clip.url || clip.pageUrl || clip.mp4Url || `file:///clip-${i + 1}.mp4`);
    resources.push(
      `<asset id="${id}" name="${name}" src="${src}" start="0s" duration="${durFrames}/${fps}s" hasVideo="1" hasAudio="1" format="r0"/>`,
    );
    spine.push(
      `<asset-clip ref="${id}" offset="${offsetFrames}/${fps}s" name="${name}" start="${Math.round((clip.trimStart || 0) * fps)}/${fps}s" duration="${durFrames}/${fps}s" tcFormat="NDF"/>`,
    );
    offsetFrames += durFrames;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r0" name="FFVideoFormat${height}p${fps}" frameDuration="${frameDuration}" width="${width}" height="${height}"/>
    ${resources.join('\n    ')}
  </resources>
  <library>
    <event name="${escapeXml(title)}">
      <project name="${escapeXml(title)}">
        <sequence format="r0" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
            ${spine.join('\n            ')}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>`;
}

module.exports = { buildFcpxml, escapeXml };
