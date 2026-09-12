'use client';

/**
 * BrandContext — CPD-331
 *
 * Tracks the active brand for multi-brand accounts. All apiFetch calls
 * automatically include X-Brand-Id when a brand is active (set via
 * setActiveBrandId in api.ts).
 *
 * On mount: loads all brands for the account, restores activeBrandId from
 * localStorage, defaults to the first brand if none saved.
 *
 * Single-brand accounts work transparently: one brand is loaded and set as
 * active with no visible UX change.
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  ReactNode,
} from 'react';
import { useAuth } from '@/lib/clerk-compat';
import { getActiveBrandId, getBrands, setActiveBrandId, type Brand } from '@/lib/api';

const LS_KEY = 'auraflux_active_brand_id';

interface BrandContextValue {
  brands:         Brand[];
  activeBrand:    Brand | null;
  setActiveBrand: (brand: Brand) => void;
  isLoading:      boolean;
  error:          string | null;
  refresh:        () => Promise<void>;
}

const BrandContext = createContext<BrandContextValue>({
  brands:         [],
  activeBrand:    null,
  setActiveBrand: () => {},
  isLoading:      true,
  error:          null,
  refresh:        async () => {},
});

export function BrandProvider({ children }: { children: ReactNode }) {
  const { isLoaded, getToken } = useAuth();
  const [brands, setBrands]       = useState<Brand[]>([]);
  const [activeBrand, setActive]  = useState<Brand | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError]         = useState<string | null>(null);

  // Track whether the user has manually set a brand so load() won't overwrite it
  const userSelectedRef = useRef(false);

  // Warp: pre-select brand after admin warp sign-in, then strip query params.
  // Do NOT hydrate X-Brand-Id from localStorage until getBrands validates ownership —
  // a leftover id from another account causes brand_access_denied on the first fetches.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const warpBrandId  = params.get('warp_brand_id');
    const warpRedirect = params.get('warp_redirect');
    if (warpBrandId) {
      localStorage.setItem(LS_KEY, warpBrandId);
      setActiveBrandId(warpBrandId);
      const clean = warpRedirect || '/settings/social';
      window.history.replaceState({}, '', clean);
    }
  }, []);

  const persistActiveBrand = useCallback((brand: Brand | null) => {
    setActiveBrandId(brand?.id ?? null);
    if (typeof window === 'undefined') return;
    if (brand?.id) localStorage.setItem(LS_KEY, brand.id);
    else localStorage.removeItem(LS_KEY);
  }, []);

  const load = useCallback(async () => {
    if (!isLoaded) return;
    setError(null);
    try {
      const token = await getToken();
      const list  = await getBrands(token ?? undefined);
      setBrands(list);

      if (!userSelectedRef.current) {
        const savedId  = typeof window !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
        const match    = savedId ? list.find((b) => b.id === savedId) : null;
        const resolved = match ?? list[0] ?? null;
        setActive(resolved);
        persistActiveBrand(resolved);
      } else {
        // Manual selection — keep if still owned; otherwise fall back (account switch)
        const currentId = getActiveBrandId();
        const stillOwns = currentId ? list.find((b) => b.id === currentId) ?? null : null;
        if (stillOwns) {
          setActive(stillOwns);
        } else {
          userSelectedRef.current = false;
          const resolved = list[0] ?? null;
          setActive(resolved);
          persistActiveBrand(resolved);
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load brands');
      // Non-fatal — backend falls back to first brand; keep stale state rather than clearing
    } finally {
      setIsLoading(false);
    }
  }, [isLoaded, getToken, persistActiveBrand]);

  useEffect(() => { load(); }, [load]);

  const setActiveBrand = useCallback((brand: Brand) => {
    userSelectedRef.current = true;
    setActive(brand);
    persistActiveBrand(brand);
  }, [persistActiveBrand]);

  return (
    <BrandContext.Provider value={{ brands, activeBrand, setActiveBrand, isLoading, error, refresh: load }}>
      {children}
    </BrandContext.Provider>
  );
}

export function useBrand(): BrandContextValue {
  return useContext(BrandContext);
}
