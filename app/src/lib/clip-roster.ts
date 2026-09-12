/**
 * Creators I clip from — per-brand roster (localStorage).
 * Not ClipzWorld ops roster; SaaS creator list of handles to pull clips from.
 */

import type { SourcePlatform } from '@/lib/api';

export interface ClipRosterEntry {
  id: string;
  platform: SourcePlatform;
  handle: string;
  displayName?: string;
}

const PREFIX = 'auraflux_clip_roster_';

function key(brandId: string | null | undefined) {
  return `${PREFIX}${brandId || 'default'}`;
}

export function loadClipRoster(brandId: string | null | undefined): ClipRosterEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key(brandId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ClipRosterEntry[];
    return Array.isArray(parsed) ? parsed.filter((e) => e?.platform && e?.handle) : [];
  } catch {
    return [];
  }
}

export function saveClipRoster(brandId: string | null | undefined, entries: ClipRosterEntry[]) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(key(brandId), JSON.stringify(entries));
}

export function makeRosterId(platform: SourcePlatform, handle: string) {
  return `${platform}:${handle.replace(/^@/, '').toLowerCase()}`;
}

export function normalizeHandle(platform: SourcePlatform, handle: string) {
  const h = handle.trim().replace(/^@/, '');
  return platform === 'youtube' ? `@${h}` : h.toLowerCase();
}
