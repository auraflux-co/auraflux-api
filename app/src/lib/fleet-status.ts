/** CPD-1067 — Solo roster fleet snapshot for dashboard + API route. */

export const TIER_C_BITRATE_K = 6800;
export const TIER_C_W = 1920;
export const TIER_C_H = 1080;

export type FleetSlotPhase = 'idle' | 'starting' | 'live' | string;

export interface FleetSlotRow {
  slot: number;
  localPool: number;
  login: string;
  platform?: string;
  phase: FleetSlotPhase;
  broadcastId?: string | null;
  watchUrl?: string | null;
}

export interface FleetOrchestratorStatus {
  fleetId: string;
  pollMs: number;
  slots: FleetSlotRow[];
}

export interface SoloEncoderRow {
  role?: string;
  quadrant?: number;
  poolSlot?: number;
  login?: string | null;
  running?: boolean;
  w?: number;
  h?: number;
  bitrateK?: number;
  restarts?: number;
}

export interface EncodeContractSnapshot {
  template?: string;
  totals?: {
    encoderCount?: number;
    configuredVideoBitrateK?: number;
  };
  passHints?: {
    allMeetYoutube1080p?: boolean;
  };
  solos?: SoloEncoderRow[];
}

export interface SidecarFleetSnapshot {
  fleetId: string;
  label: string;
  url: string;
  ok: boolean;
  error?: string;
  running: boolean;
  uptimeSec?: number;
  fleet: FleetOrchestratorStatus | null;
  encodeContract: EncodeContractSnapshot | null;
  alerts: string[];
  liveCount: number;
}

export interface FleetDashboardSnapshot {
  ok: boolean;
  updatedAt: string;
  tierC: { w: number; h: number; bitrateK: number };
  sidecars: SidecarFleetSnapshot[];
  alerts: string[];
  totalLive: number;
}

const SIDECAR_A = process.env.BROADCAST_SIDECAR_URL
  || process.env.NEXT_PUBLIC_BROADCAST_SIDECAR_URL
  || 'https://auraflux-broadcast-staging.onrender.com';
const SIDECAR_B = process.env.BROADCAST_SIDECAR_B_URL
  || process.env.NEXT_PUBLIC_BROADCAST_SIDECAR_B_URL
  || 'https://auraflux-broadcast-staging-b.onrender.com';

function soloContractOk(solo: SoloEncoderRow): { ok: boolean; reason?: string; issues?: string[] } {
  if (!solo?.running) return { ok: false, reason: 'encoder_not_running' };
  const issues: string[] = [];
  if (solo.w && solo.w < TIER_C_W) issues.push(`width ${solo.w}<${TIER_C_W}`);
  if (solo.h && solo.h < TIER_C_H) issues.push(`height ${solo.h}<${TIER_C_H}`);
  if (solo.bitrateK && solo.bitrateK < TIER_C_BITRATE_K * 0.9) {
    issues.push(`bitrate ${solo.bitrateK}k<${TIER_C_BITRATE_K}k`);
  }
  return { ok: issues.length === 0, issues };
}

async function fetchJson<T>(url: string, path: string, ms = 20_000): Promise<{ data: T | null; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}${path}`, {
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      return { data: null, error: body.error || res.statusText };
    }
    return { data: (await res.json()) as T };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : 'fetch failed' };
  } finally {
    clearTimeout(t);
  }
}

function buildSidecarAlerts(
  fleetId: string,
  status: Record<string, unknown> | null,
  encodeContract: EncodeContractSnapshot | null,
): string[] {
  const alerts: string[] = [];
  if (!status) return alerts;

  const fleet = status.fleetOrchestrator as FleetOrchestratorStatus | null | undefined;
  if (status.running && !fleet) alerts.push(`${fleetId}: running but not fleet mode`);

  const solos = encodeContract?.solos || [];
  for (const slot of fleet?.slots || []) {
    if (slot.phase !== 'live' && slot.phase !== 'starting') continue;
    const soloEnc = solos.find((s) => (s.poolSlot ?? s.quadrant) === slot.localPool);
    if (!soloEnc) {
      alerts.push(`${fleetId} slot ${slot.slot}: live phase but no encoder in contract`);
      continue;
    }
    const chk = soloContractOk(soloEnc);
    if (!chk.ok) {
      alerts.push(`${fleetId} slot ${slot.slot}: Tier C ${chk.reason || chk.issues?.join(', ')}`);
    }
  }

  const liveCount = (fleet?.slots || []).filter((s) => s.phase === 'live').length;
  if (liveCount >= 3 && encodeContract?.totals?.configuredVideoBitrateK) {
    const expectedK = liveCount * TIER_C_BITRATE_K;
    if (encodeContract.totals.configuredVideoBitrateK < expectedK * 0.85) {
      alerts.push(`${fleetId}: configured ${encodeContract.totals.configuredVideoBitrateK}k below Tier C ~${expectedK}k`);
    }
  }

  return alerts;
}

export async function fetchFleetDashboardSnapshot(): Promise<FleetDashboardSnapshot> {
  const sidecarDefs = [
    { fleetId: 'a', label: 'Sidecar A · slots 1–5', url: SIDECAR_A },
    { fleetId: 'b', label: 'Sidecar B · slots 6–10', url: SIDECAR_B },
  ];

  const sidecars: SidecarFleetSnapshot[] = await Promise.all(
    sidecarDefs.map(async ({ fleetId, label, url }) => {
      const statusRes = await fetchJson<Record<string, unknown>>(url, '/live-grid/status');
      const contractRes = statusRes.data?.running
        ? await fetchJson<{ contract?: EncodeContractSnapshot }>(url, '/live-grid/encode-contract')
        : { data: null };

      const status = statusRes.data;
      const encodeContract = contractRes.data?.contract
        ?? (status?.encodeContract as EncodeContractSnapshot | undefined)
        ?? null;
      const fleet = (status?.fleetOrchestrator as FleetOrchestratorStatus | undefined) ?? null;
      const alerts = buildSidecarAlerts(fleetId, status, encodeContract);

      if (statusRes.error) alerts.unshift(`${fleetId}: ${statusRes.error}`);
      if (contractRes.error && status?.running) {
        alerts.push(`${fleetId}: encode-contract ${contractRes.error}`);
      }

      const liveCount = (fleet?.slots || []).filter((s) => s.phase === 'live').length;

      return {
        fleetId,
        label,
        url,
        ok: !statusRes.error,
        error: statusRes.error,
        running: !!(status?.running),
        uptimeSec: typeof status?.uptimeSec === 'number' ? status.uptimeSec : undefined,
        fleet,
        encodeContract,
        alerts,
        liveCount,
      };
    }),
  );

  const alerts = sidecars.flatMap((s) => s.alerts);
  const totalLive = sidecars.reduce((n, s) => n + s.liveCount, 0);

  return {
    ok: sidecars.some((s) => s.ok),
    updatedAt: new Date().toISOString(),
    tierC: { w: TIER_C_W, h: TIER_C_H, bitrateK: TIER_C_BITRATE_K },
    sidecars,
    alerts,
    totalLive,
  };
}

export function phaseBadgeClass(phase: FleetSlotPhase): string {
  if (phase === 'live') return 'bg-red-500/20 text-red-300 border-red-500/40';
  if (phase === 'starting') return 'bg-amber-500/20 text-amber-200 border-amber-500/40';
  return 'bg-muted/40 text-muted-foreground border-border';
}
