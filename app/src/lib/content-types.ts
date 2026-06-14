/**
 * Content type definitions — display labels for all job content types.
 * Single source of truth for CPD-103 / CPD-107.
 */

export const CONTENT_TYPE_LABELS: Record<string, string> = {
  'news-long':       'News (Long-form)',
  'news-short':      'News (Short-form)',
  'clips-long':      'Clips (Long-form)',
  'clips-short':     'Clips (Short-form)',
  'clips':           'Clips',
  'sports-long':     'Sports (Long-form)',
  'sports-short':    'Sports (Short-form)',
  'show_commentary': 'Narrative Clip Content',
  'custom':          'Custom',
};

export const CONTENT_TYPES_ORDERED = [
  'news-long',
  'news-short',
  'clips-long',
  'clips-short',
  'sports-long',
  'sports-short',
  'show_commentary',
  'custom',
] as const;

export type ContentTypeKey = (typeof CONTENT_TYPES_ORDERED)[number];

export function labelForContentType(ct: string): string {
  return CONTENT_TYPE_LABELS[ct] ?? ct;
}
