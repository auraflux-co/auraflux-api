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

interface PlanContextValue {
  planTier:  PlanTier | null;
  isLoading: boolean;
}

const PlanContext = createContext<PlanContextValue>({ planTier: null, isLoading: true });

export function PlanProvider({ children }: { children: ReactNode }) {
  const { isLoaded } = useAuth();
  const [planTier, setPlanTier]   = useState<PlanTier | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!isLoaded) return;
    apiFetch<{ planTier: PlanTier }>('/plan/features')
      .then(d => setPlanTier(d.planTier ?? 'diy'))
      .catch(() => setPlanTier('diy'))
      .finally(() => setIsLoading(false));
  }, [isLoaded]);

  return (
    <PlanContext.Provider value={{ planTier, isLoading }}>
      {children}
    </PlanContext.Provider>
  );
}

export function usePlan(): PlanContextValue {
  return useContext(PlanContext);
}
