'use client';

/**
 * PlanContext — CPD-127
 *
 * Provides the current user's planTier throughout the dashboard.
 * Clerk publicMetadata is the immediate source; /plan/features enriches
 * with the feature matrix when the API is reachable.
 */

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { useAuth, useUser } from '@/lib/clerk-compat';
import { apiFetch, type PlanTier } from '@/lib/api';

type PlanFeaturesResp = { ok: boolean; planTier: PlanTier; features: Record<string, boolean> };

const TIER_ALIASES: Record<string, PlanTier> = { diy: 'operate', dwy: 'guided', dfy: 'managed' };
function normaliseTier(raw: string | null | undefined): PlanTier | null {
  if (!raw) return null;
  return (TIER_ALIASES[raw] ?? raw) as PlanTier;
}

interface PlanContextValue {
  planTier:  PlanTier | null;
  isLoading: boolean;
}

const PlanContext = createContext<PlanContextValue>({ planTier: null, isLoading: true });

export function PlanProvider({ children }: { children: ReactNode }) {
  const { isLoaded, getToken } = useAuth();
  const { user }               = useUser();
  const clerkTier              = normaliseTier(user?.publicMetadata?.planTier as string | undefined);
  const [planTier, setPlanTier]   = useState<PlanTier | null>(clerkTier);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (clerkTier) setPlanTier(clerkTier);
  }, [clerkTier]);

  useEffect(() => {
    if (!isLoaded) return;
    let cancelled = false;

    (async () => {
      try {
        const token = await getToken();
        const data  = await apiFetch<PlanFeaturesResp>('/plan/features', { token: token ?? undefined });
        if (!cancelled) setPlanTier(normaliseTier(data.planTier) ?? clerkTier);
      } catch {
        // Never default to operate on API failure — that mis-gates Guided/Managed users.
        if (!cancelled) setPlanTier((prev) => prev ?? clerkTier);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [isLoaded, getToken, clerkTier]);

  return (
    <PlanContext.Provider value={{ planTier, isLoading }}>
      {children}
    </PlanContext.Provider>
  );
}

export function usePlan(): PlanContextValue {
  return useContext(PlanContext);
}
