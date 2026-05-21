'use client';
/**
 * JobTimingPicker — production start, publish timing, and recurring template options.
 * CPD-118 (scheduled start) + CPD-119 (recurring templates) + CPD-48 (deferred publish).
 */

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { SchedulePicker, type ScheduleValue } from '@/components/jobs/schedule-picker';
import type { RecurrenceType } from '@/lib/api';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export type ProductionStartMode = 'now' | 'scheduled';

export interface ProductionStartValue {
  mode: ProductionStartMode;
  scheduledStartAt?: string;
}

export interface RecurrenceValue {
  enabled: boolean;
  templateName: string;
  recurrenceType: RecurrenceType;
  recurrenceDay: number;
  recurrenceTime: string;
}

export interface JobTimingValue {
  productionStart: ProductionStartValue;
  publish: ScheduleValue;
  recurrence: RecurrenceValue;
}

export const DEFAULT_JOB_TIMING: JobTimingValue = {
  productionStart: { mode: 'now' },
  publish: { publishMode: 'immediate' },
  recurrence: {
    enabled: false,
    templateName: '',
    recurrenceType: 'weekly',
    recurrenceDay: 1,
    recurrenceTime: '09:00',
  },
};

function minDateTime(): string {
  const d = new Date(Date.now() + 31 * 60 * 1000);
  return d.toISOString().slice(0, 16);
}

function maxDateTime(): string {
  const d = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000 - 60000);
  return d.toISOString().slice(0, 16);
}

interface JobTimingPickerProps {
  platforms: string[];
  value: JobTimingValue;
  onChange: (v: JobTimingValue) => void;
  className?: string;
}

export function JobTimingPicker({ platforms, value, onChange, className }: JobTimingPickerProps) {
  const [localStartDt, setLocalStartDt] = useState(
    value.productionStart.scheduledStartAt?.slice(0, 16) ?? '',
  );

  useEffect(() => {
    if (value.productionStart.scheduledStartAt) {
      setLocalStartDt(value.productionStart.scheduledStartAt.slice(0, 16));
    }
  }, [value.productionStart.scheduledStartAt]);

  function patch(partial: Partial<JobTimingValue>) {
    onChange({ ...value, ...partial });
  }

  function setProductionStart(productionStart: ProductionStartValue) {
    patch({ productionStart });
  }

  function setRecurrence(recurrence: RecurrenceValue) {
    patch({ recurrence });
  }

  function handleStartMode(mode: ProductionStartMode) {
    setProductionStart({
      mode,
      scheduledStartAt:
        mode === 'scheduled'
          ? (localStartDt ? `${localStartDt}:00` : undefined)
          : undefined,
    });
  }

  function handleStartDateChange(raw: string) {
    setLocalStartDt(raw);
    if (value.productionStart.mode === 'scheduled') {
      setProductionStart({
        mode: 'scheduled',
        scheduledStartAt: raw ? `${raw}:00` : undefined,
      });
    }
  }

  return (
    <div className={cn('space-y-4', className)}>
      {/* Production start */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Production start</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            When the pipeline begins processing your content. Scheduled starts charge credits at fire time.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => handleStartMode('now')}
              className={cn(
                'flex-1 py-1.5 text-xs rounded border transition-colors',
                value.productionStart.mode === 'now'
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              Start now
            </button>
            <button
              type="button"
              onClick={() => handleStartMode('scheduled')}
              className={cn(
                'flex-1 py-1.5 text-xs rounded border transition-colors',
                value.productionStart.mode === 'scheduled'
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              Schedule start
            </button>
          </div>
          {value.productionStart.mode === 'scheduled' && (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Start date & time (local)</label>
              <input
                type="datetime-local"
                value={localStartDt}
                min={minDateTime()}
                max={maxDateTime()}
                onChange={(e) => handleStartDateChange(e.target.value)}
                className="w-full rounded-md border border-border px-2 py-1.5 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {localStartDt && (
                <p className="text-xs text-muted-foreground">
                  Production begins{' '}
                  <span className="font-medium text-foreground">
                    {new Date(`${localStartDt}:00`).toLocaleString(undefined, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                  . Job appears in Scheduled until then.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Publish timing (deferred publish after assembly) */}
      <SchedulePicker
        platforms={platforms}
        value={value.publish}
        onChange={(publish) => patch({ publish })}
      />

      {/* Recurring template */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Repeat this job</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={value.recurrence.enabled}
              onChange={(e) =>
                setRecurrence({ ...value.recurrence, enabled: e.target.checked })
              }
              className="rounded border-border"
            />
            <span>Save as recurring template</span>
          </label>
          {value.recurrence.enabled && (
            <div className="space-y-3 pl-1">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Template name</Label>
                <Input
                  value={value.recurrence.templateName}
                  onChange={(e) =>
                    setRecurrence({ ...value.recurrence, templateName: e.target.value })
                  }
                  placeholder="e.g. Weekly news roundup"
                  className="h-8 text-sm"
                />
              </div>
              <div className="flex flex-wrap gap-3 items-end">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Frequency</Label>
                  <select
                    value={value.recurrence.recurrenceType}
                    onChange={(e) =>
                      setRecurrence({
                        ...value.recurrence,
                        recurrenceType: e.target.value as RecurrenceType,
                      })
                    }
                    className="block text-sm border border-border rounded px-2 py-1.5 bg-background"
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
                {value.recurrence.recurrenceType === 'weekly' && (
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Day</Label>
                    <select
                      value={value.recurrence.recurrenceDay}
                      onChange={(e) =>
                        setRecurrence({
                          ...value.recurrence,
                          recurrenceDay: Number(e.target.value),
                        })
                      }
                      className="block text-sm border border-border rounded px-2 py-1.5 bg-background"
                    >
                      {DAYS.map((d, i) => (
                        <option key={d} value={i}>{d}</option>
                      ))}
                    </select>
                  </div>
                )}
                {value.recurrence.recurrenceType === 'monthly' && (
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Day of month</Label>
                    <input
                      type="number"
                      min={1}
                      max={28}
                      value={value.recurrence.recurrenceDay}
                      onChange={(e) =>
                        setRecurrence({
                          ...value.recurrence,
                          recurrenceDay: Number(e.target.value),
                        })
                      }
                      className="block w-16 text-sm border border-border rounded px-2 py-1.5 bg-background"
                    />
                  </div>
                )}
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Time (UTC)</Label>
                  <input
                    type="time"
                    value={value.recurrence.recurrenceTime}
                    onChange={(e) =>
                      setRecurrence({
                        ...value.recurrence,
                        recurrenceTime: e.target.value,
                      })
                    }
                    className="block text-sm border border-border rounded px-2 py-1.5 bg-background"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {value.productionStart.mode === 'now'
                  ? 'Runs immediately once, then repeats on this cadence. Upcoming runs appear under Scheduled.'
                  : 'First run at your scheduled production start time, then repeats on this cadence.'}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
