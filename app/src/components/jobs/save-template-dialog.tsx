'use client';

import { useState, useEffect } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { RecurrenceType } from '@/lib/api';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export interface SaveTemplateOptions {
  name: string;
  description?: string;
  recurrenceType?: RecurrenceType;
  recurrenceDay?: number;
  recurrenceTime?: string;
}

interface SaveTemplateDialogProps {
  open: boolean;
  defaultName: string;
  saving?: boolean;
  onClose: () => void;
  onSave: (opts: SaveTemplateOptions) => void;
}

export function SaveTemplateDialog({
  open,
  defaultName,
  saving,
  onClose,
  onSave,
}: SaveTemplateDialogProps) {
  const [name, setName] = useState(defaultName);
  const [description, setDescription] = useState('');
  const [recurrenceEnabled, setRecurrenceEnabled] = useState(false);
  const [recurrenceType, setRecurrenceType] = useState<RecurrenceType>('weekly');
  const [recurrenceDay, setRecurrenceDay] = useState(1);
  const [recurrenceTime, setRecurrenceTime] = useState('09:00');

  useEffect(() => {
    if (open) {
      setName(defaultName);
      setDescription('');
      setRecurrenceEnabled(false);
      setRecurrenceType('weekly');
      setRecurrenceDay(1);
      setRecurrenceTime('09:00');
    }
  }, [open, defaultName]);

  if (!open) return null;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onSave({
      name: name.trim(),
      description: description.trim() || undefined,
      recurrenceType: recurrenceEnabled ? recurrenceType : 'once',
      recurrenceDay: recurrenceEnabled ? recurrenceDay : undefined,
      recurrenceTime: recurrenceEnabled ? recurrenceTime : undefined,
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        role="dialog"
        aria-labelledby="save-template-title"
        className="bg-card border border-border rounded-lg w-full max-w-md p-6 space-y-4 shadow-lg"
      >
        <div>
          <h2 id="save-template-title" className="text-lg font-semibold">Save as template</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Reuse this job configuration. Optionally set a recurrence cadence for automatic runs.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-name">Template name</Label>
            <Input
              id="tpl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="tpl-desc">Description (optional)</Label>
            <Input
              id="tpl-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this template is for"
            />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={recurrenceEnabled}
              onChange={(e) => setRecurrenceEnabled(e.target.checked)}
              className="rounded border-border"
            />
            Schedule recurring runs
          </label>

          {recurrenceEnabled && (
            <div className="flex flex-wrap gap-3 items-end rounded-md border border-border bg-muted/20 p-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Frequency</Label>
                <select
                  value={recurrenceType}
                  onChange={(e) => setRecurrenceType(e.target.value as RecurrenceType)}
                  className="block text-sm border border-border rounded px-2 py-1.5 bg-background"
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
              {recurrenceType === 'weekly' && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Day</Label>
                  <select
                    value={recurrenceDay}
                    onChange={(e) => setRecurrenceDay(Number(e.target.value))}
                    className="block text-sm border border-border rounded px-2 py-1.5 bg-background"
                  >
                    {DAYS.map((d, i) => (
                      <option key={d} value={i}>{d}</option>
                    ))}
                  </select>
                </div>
              )}
              {recurrenceType === 'monthly' && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Day of month</Label>
                  <input
                    type="number"
                    min={1}
                    max={28}
                    value={recurrenceDay}
                    onChange={(e) => setRecurrenceDay(Number(e.target.value))}
                    className="block w-16 text-sm border border-border rounded px-2 py-1.5 bg-background"
                  />
                </div>
              )}
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Time (UTC)</Label>
                <input
                  type="time"
                  value={recurrenceTime}
                  onChange={(e) => setRecurrenceTime(e.target.value)}
                  className="block text-sm border border-border rounded px-2 py-1.5 bg-background"
                />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
            >
              Cancel
            </button>
            <Button type="submit" size="sm" disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : 'Save template'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
