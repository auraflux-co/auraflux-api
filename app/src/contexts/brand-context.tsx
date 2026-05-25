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
  useState,
  useCallback,
  ReactNode,
} from 'react';
import { useAuth } from '@clerk/nextjs';
import { getBrands, setActiveBrandId, type Brand } from '@/lib/api';

const LS_KEY = 'auraflux_active_brand_id';

interface BrandContextValue {
  brands:        Brand[];
  activeBrand:   Brand | null;
  setActiveBrand: (brand: Brand) => void;
  isLoading:     boolean;
  refresh:       () => void;
}

const BrandContext = createContext<BrandContextValue>({
  brands:        [],
  activeBrand:   null,
  setActiveBrand: () => {},
  isLoading:     true,
  refresh:       () => {},
});

export function BrandProvider({ children }: { children: ReactNode }) {
  const { isLoaded, getToken } = useAuth();
  const [brands, setBrands]       = useState<Brand[]>([]);
  const [activeBrand, setActive]  = useState<Brand | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    if (!isLoaded) return;
    try {
      const token = await getToken();
      const list  = await getBrands(token ?? undefined);
      setBrands(list);

      // Restore previously active brand from localStorage
      const savedId = typeof window !== 'undefined'
        ? localStorage.getItem(LS_KEY)
        : null;
      const match = savedId ? list.find((b) => b.id === savedId) : null;
      const resolved = match ?? list[0] ?? null;

      setActive(resolved);
      setActiveBrandId(resolved?.id ?? null);
    } catch {
      // Non-fatal — single-brand flows still work via fallback in backend
    } finally {
      setIsLoading(false);
    }
  }, [isLoaded, getToken]);

  useEffect(() => { load(); }, [load]);

  const setActiveBrand = useCallback((brand: Brand) => {
    setActive(brand);
    setActiveBrandId(brand.id);
    if (typeof window !== 'undefined') {
      localStorage.setItem(LS_KEY, brand.id);
    }
  }, []);

  return (
    <BrandContext.Provider value={{ brands, activeBrand, setActiveBrand, isLoading, refresh: load }}>
      {children}
    </BrandContext.Provider>
  );
}

export function useBrand(): BrandContextValue {
  return useContext(BrandContext);
}
