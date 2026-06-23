'use strict';

/** Canonical reference library for Hook Master ingest (CPD-1086). */
const HOOK_MASTER_SOURCES = [
  {
    id: 'jade-beason-100-hooks',
    type: 'video',
    title: 'I studied 100+ hooks, this strategy will make you go viral',
    url: 'https://www.youtube.com/watch?v=dNT7gd3ulAg',
    author: 'Jade Beason',
  },
  {
    id: 'kallaway-irresistible-hooks',
    type: 'video',
    title: 'How to Create Irresistible Hooks (and blow up your content)',
    url: 'https://www.youtube.com/watch?v=LmXpbP7dD48',
    author: 'Kallaway',
  },
  {
    id: 'ref-short-a',
    type: 'video',
    title: 'Reference Short A',
    url: 'https://www.youtube.com/shorts/gwc9_z6Zce0',
    author: 'reference',
  },
  {
    id: 'ref-video-b',
    type: 'video',
    title: 'Reference video B',
    url: 'https://www.youtube.com/watch?v=VQMPTvnkEAQ',
    author: 'reference',
  },
  {
    id: 'ref-video-c',
    type: 'video',
    title: 'Reference video C',
    url: 'https://www.youtube.com/watch?v=xnOe8aA9Pmw',
    author: 'reference',
  },
  {
    id: 'opus-shorts-hook-formulas',
    type: 'article',
    title: 'YouTube Shorts Hook Formulas',
    url: 'https://www.opus.pro/blog/youtube-shorts-hook-formulas',
    author: 'Opus',
  },
  {
    id: 'vidiq-viral-hooks',
    type: 'article',
    title: 'Viral Video Hooks for YouTube Shorts',
    url: 'https://vidiq.com/blog/post/viral-video-hooks-youtube-shorts/',
    author: 'vidIQ',
  },
];

const PASS_FOCUS = [
  'psychology — dopamine, curiosity loops, pattern interrupts, loss aversion, 3-second clarity',
  'named formulas — Contrarian, Fortune Teller, Result Preview, context lean, scroll-stop, contrarian snapback',
  'good vs bad hook examples — verbatim lines that worked vs generic filler',
  'visual hook tactics — movement, emotion, contrast, mute-first narrative',
  'text hook tactics — 3–6 word burned captions, information gap, no punchline spoil',
];

function getSourceById(id) {
  return HOOK_MASTER_SOURCES.find((s) => s.id === id) || null;
}

module.exports = {
  HOOK_MASTER_SOURCES,
  PASS_FOCUS,
  getSourceById,
};
