'use client';
/**
 * SchedulePicker — CPD-48
 *
 * Provides a "Publish now" vs "Schedule" toggle.
 * When "Schedule" is selected, shows a date/time input and
 * highlights platform-specific best-practice windows.
 *
 * Best-practice data is baked in (no API call needed) and sourced
 * from the CPD-48 Jira spec.
 */

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PublishMode = 'immediate' | 'scheduled';

export interface ScheduleValue {
  publishMode:         PublishMode;
  scheduledPublishAt?: string; // ISO 8601
}

interface SchedulePickerProps {
  platforms: string[];
  value:     ScheduleValue;
  onChange:  (v: ScheduleValue) => void;
  className?: string;
}

// ─── Platform best-practice data ─────────────────────────────────────────────

interface PlatformSchedule {
  label:       string;
  bestDays:    string;
  bestTimes:   string;
  peakSlots:   string[]; // ISO time strings like "14:00" — highlighted on picker
  frequency:   string;
}

const PLATFORM_SCHEDULES: Record<string, PlatformSchedule> = {
  youtube: {
    label:     'YouTube',
    bestDays:  'Thu, Fri (general); Sat–Sun (gaming/entertainment)',
    bestTimes: '12pm–4pm ET · 7pm–9pm ET',
    peakSlots: ['12:00', '13:00', '14:00', '15:00', '16:00', '19:00', '20:00', '21:00'],
    frequency: '1–3× per week',
  },
  tiktok: {
    label:     'TikTok',
    bestDays:  'Tue, Wed, Thu; Fri–Sat for entertainment',
    bestTimes: '6pm–9pm ET · 12pm–2pm ET',
    peakSlots: ['12:00', '13:00', '14:00', '18:00', '19:00', '20:00', '21:00'],
    frequency: '3–5× per week',
  },
  instagram: {
    label:     'Instagram Reels',
    bestDays:  'Mon, Wed, Fri',
    bestTimes: '11am–1pm ET · 7pm–9pm ET',
    peakSlots: ['11:00', '12:00', '13:00', '19:00', '20:00', '21:00'],
    frequency: '3–4× per week',
  },
  twitter: {
    label:     'Twitter / X',
    bestDays:  'Mon–Thu',
    bestTimes: '8am–10am ET · 12pm–1pm ET · 5pm–6pm ET',
    peakSlots: ['08:00', '09:00', '10:00', '12:00', '13:00', '17:00', '18:00'],
    frequency: 'Daily or 2× daily for news',
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function minDateTime(): string {
  // min 30 min in future
  const d = new Date(Date.now() + 31 * 60 * 1000);
  return d.toISOString().slice(0, 16);
}

function maxDateTime(): string {
  // max 60 days in future
  const d = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000 - 60000);
  return d.toISOString().slice(0, 16);
}

function isPeakHour(isoDateTime: string, peakSlots: string[]): boolean {
  if (!isoDateTime) return false;
  const hour = isoDateTime.slice(11, 16); // "HH:MM"
  return peakSlots.some((slot) => slot === hour || (slot >= hour && slot <= `${hour.slice(0, 2)}:59`));
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SchedulePicker({ platforms, value, onChange, className }: SchedulePickerProps) {
  const [localDt, setLocalDt] = useState(value.scheduledPublishAt?.slice(0, 16) ?? '');

  // Sync external value → local state
  useEffect(() => {
    if (value.scheduledPublishAt) setLocalDt(value.scheduledPublishAt.slice(0, 16));
  }, [value.scheduledPublishAt]);

  const knownPlatforms = platforms.filter((p) => PLATFORM_SCHEDULES[p.toLowerCase()]);

  function handleModeChange(mode: PublishMode) {
    onChange({ publishMode: mode, scheduledPublishAt: mode === 'scheduled' ? localDt || undefined : undefined });
  }

  function handleDateChange(raw: string) {
    setLocalDt(raw);
    if (value.publishMode === 'scheduled') {
      onChange({ publishMode: 'scheduled', scheduledPublishAt: raw ? `${raw}:00` : undefined });
    }
  }

  const isPeak = value.publishMode === 'scheduled' && localDt
    ? knownPlatforms.some((p) => isPeakHour(localDt, PLATFORM_SCHEDULES[p.toLowerCase()].peakSlots))
    : false;

  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Publish timing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Toggle */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleModeChange('immediate')}
            className={cn(
              'flex-1 py-1.5 text-xs rounded border transition-colors',
              value.publishMode === 'immediate'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            Publish now
          </button>
          <button
            type="button"
            onClick={() => handleModeChange('scheduled')}
            className={cn(
              'flex-1 py-1.5 text-xs rounded border transition-colors',
              value.publishMode === 'scheduled'
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            Schedule
          </button>
        </div>

        {/* Date / time picker */}
        {value.publishMode === 'scheduled' && (
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Date & time (your local time)</label>
              <input
                type="datetime-local"
                value={localDt}
                min={minDateTime()}
                max={maxDateTime()}
                onChange={(e) => handleDateChange(e.target.value)}
                className={cn(
                  'w-full rounded-md border px-2 py-1.5 text-sm bg-background',
                  'focus:outline-none focus:ring-2 focus:ring-ring',
                  isPeak ? 'border-green-500 ring-1 ring-green-500/30' : 'border-border',
                )}
              />
              {isPeak && (
                <p className="text-[10px] text-green-600 dark:text-green-400">
                  Peak engagement window for your selected platform(s)
                </p>
              )}
            </div>

            {/* Platform best-practice windows */}
            {knownPlatforms.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                  Best-practice windows
                </p>
                {knownPlatforms.map((p) => {
                  const cfg = PLATFORM_SCHEDULES[p.toLowerCase()];
                  const highlightHours = cfg.peakSlots.slice(0, 3);
                  const localHour = localDt.slice(11, 13);
                  const atPeak = cfg.peakSlots.some((s) => s.slice(0, 2) === localHour);
                  return (
                    <div key={p} className="text-xs border rounded p-2 space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{cfg.label}</span>
                        {atPeak && <Badge variant="secondary" className="text-[10px] px-1 py-0">Peak</Badge>}
                      </div>
                      <p className="text-muted-foreground text-[10px]">{cfg.bestDays}</p>
                      <p className="text-muted-foreground text-[10px]">
                        {cfg.bestTimes} · {cfg.frequency}
                      </p>
                      {/* Visual hour strip */}
                      <div className="flex gap-0.5 mt-1">
                        {Array.from({ length: 24 }, (_, i) => {
                          const hh = String(i).padStart(2, '0');
                          const peak = cfg.peakSlots.some((s) => s.startsWith(hh));
                          const active = localDt && localDt.slice(11, 13) === hh;
                          return (
                            <div
                              key={i}
                              title={`${hh}:00`}
                              className={cn(
                                'flex-1 h-1.5 rounded-sm',
                                active ? 'bg-blue-500' :
                                peak   ? 'bg-green-500/60' :
                                'bg-muted/40',
                              )}
                            />
                          );
                        })}
                      </div>
                      <p className="text-[10px] text-muted-foreground flex gap-2">
                        <span className="flex items-center gap-0.5"><span className="inline-block w-2 h-1.5 rounded-sm bg-green-500/60" /> peak</span>
                        <span className="flex items-center gap-0.5"><span className="inline-block w-2 h-1.5 rounded-sm bg-blue-500" /> selected</span>
                      </p>
                    </div>
                  );
                })}
              </div>
            )}

            {localDt && (
              <p className="text-xs text-muted-foreground bg-muted/40 rounded px-2 py-1.5">
                Your video will publish on{' '}
                <span className="font-medium text-foreground">
                  {new Date(`${localDt}:00`).toLocaleString('en-US', {
                    weekday: 'long', month: 'long', day: 'numeric',
                    hour: 'numeric', minute: '2-digit',
                  })}
                </span>
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
