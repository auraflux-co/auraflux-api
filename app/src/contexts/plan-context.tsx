'use client';

/**
 * PlanContext — CPD-127
 *
 * Provides the current user's planTier throughout the dashboard.
 * Loaded once at the dashboard layout level, read anywhere with usePlan().
 */

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { useAuth } from '@clerk/nextjs';
import { apiFetch, type PlanTier } from '@/lib/api';

type PlanFeaturesResp = { ok: boolean; planTier: PlanTier; features: Record<string, boolean> };

// Map legacy tier keys emitted by the API before migration
const TIER_ALIASES: Record<string, PlanTier> = { diy: 'operate', dwy: 'guided', dfy: 'managed' };
function normaliseTier(raw: string | null | undefined): PlanTier {
  if (!raw) return 'operate';
  return (TIER_ALIASES[raw] ?? raw) as PlanTier;
}

interface PlanContextValue {
  planTier:  PlanTier | null;
  isLoading: boolean;
}

const PlanContext = createContext<PlanContextValue>({ planTier: null, isLoading: true });

export function PlanProvider({ children }: { children: ReactNode }) {
  const { isLoaded, getToken } = useAuth();
  const [planTier, setPlanTier]   = useState<PlanTier | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!isLoaded) return;
    getToken().then(token =>
      apiFetch<PlanFeaturesResp>('/plan/features', { token: token ?? undefined })
        .then(d => setPlanTier(normaliseTier(d.planTier)))
        .catch(() => setPlanTier('operate'))
        .finally(() => setIsLoading(false))
    );
  }, [isLoaded, getToken]);

  return (
    <PlanContext.Provider value={{ planTier, isLoading }}>
      {children}
    </PlanContext.Provider>
  );
}

export function usePlan(): PlanContextValue {
  return useContext(PlanContext);
}
