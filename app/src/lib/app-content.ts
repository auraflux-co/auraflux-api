/**
 * app-content.ts — CPD-490: App CMS content resolver
 *
 * Usage:
 *   const copy = await getAppContent('myjobs');
 *   const title = content(copy, 'empty_state_title', 'No jobs yet');
 *
 * DB overrides (set by superadmin via /admin/content) win over JSON defaults.
 * Falls back silently to the provided default if neither exists.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'https://api.auraflux.co';
const CACHE_TTL = 5 * 60 * 1000; // 5 min — mirrors server-side cache

let _allContent: Record<string, Record<string, string>> | null = null;
let _fetchedAt = 0;
let _inflight: Promise<void> | null = null;

async function _load(): Promise<void> {
  if (_inflight) return _inflight;
  _inflight = fetch(`${API_BASE}/api/admin/app-content`, { next: { revalidate: 300 } })
    .then((r) => r.json())
    .then((data) => {
      if (data?.ok) {
        _allContent = data.content ?? {};
        _fetchedAt = Date.now();
      }
    })
    .catch(() => {
      // Non-fatal — fall through to JSON defaults
    })
    .finally(() => {
      _inflight = null;
    });
  return _inflight;
}

/** Return the content map for a page key, merging DB overrides over defaults. */
export async function getAppContent(pageKey: string): Promise<Record<string, string>> {
  if (!_allContent || Date.now() - _fetchedAt > CACHE_TTL) {
    await _load();
  }
  return _allContent?.[pageKey] ?? {};
}

/** Resolve a content key: DB override > provided default. */
export function content(
  overrides: Record<string, string>,
  key: string,
  defaultValue: string,
): string {
  return overrides[key] ?? defaultValue;
}
