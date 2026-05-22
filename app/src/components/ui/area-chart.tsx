'use client';
/**
 * AreaChart — branded recharts area chart.
 *
 * Usage:
 *   <AreaChart
 *     data={[{ date: 'Jan', jobs: 12, credits: 340 }]}
 *     categories={['jobs', 'credits']}
 *     index="date"
 *     height={220}
 *   />
 *
 * Colors cycle through the brand palette (chart-1 → chart-5).
 */

import {
  AreaChart as RechartsAreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { cn } from '@/lib/utils';

// Tailwind v4 exposes CSS custom props as oklch — use css var refs directly.
const COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
] as const;

// ─── Custom tooltip ───────────────────────────────────────────────────────────

interface TooltipEntry {
  dataKey: string;
  name?: string;
  value?: number | string;
  color?: string;
}

interface TooltipPayload {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
}

function ChartTooltip({ active, payload, label }: TooltipPayload) {
  if (!active || !payload?.length) return null;
  return (
    <div className="af-surface-raised px-3 py-2.5 space-y-1 text-left min-w-[120px]">
      <p className="af-caption font-semibold text-foreground/70">{label}</p>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-1.5">
            <span
              className="w-2 h-2 rounded-full inline-block shrink-0"
              style={{ background: entry.color }}
            />
            <span className="af-caption text-foreground">{entry.name}</span>
          </div>
          <span className="af-caption font-semibold text-foreground">
            {typeof entry.value === 'number' ? entry.value.toLocaleString() : entry.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── AreaChart ────────────────────────────────────────────────────────────────

interface AreaChartProps {
  /** Array of data objects. */
  data: Record<string, unknown>[];
  /** Key to use as the X axis. */
  index: string;
  /** Keys to plot as areas. */
  categories: string[];
  /** Chart height in px. Defaults to 220. */
  height?: number;
  /** Show Y axis. Defaults to false (cleaner look). */
  showYAxis?: boolean;
  className?: string;
}

export function AreaChart({
  data,
  index,
  categories,
  height = 220,
  showYAxis = false,
  className,
}: AreaChartProps) {
  return (
    <div className={cn('w-full', className)} style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <RechartsAreaChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <defs>
            {categories.map((cat, i) => (
              <linearGradient key={cat} id={`af-area-${cat}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={COLORS[i % COLORS.length]} stopOpacity={0.25} />
                <stop offset="95%" stopColor={COLORS[i % COLORS.length]} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--color-border)"
            vertical={false}
          />
          <XAxis
            dataKey={index}
            tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
            axisLine={false}
            tickLine={false}
          />
          {showYAxis && (
            <YAxis
              tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
              axisLine={false}
              tickLine={false}
              width={36}
            />
          )}
          <Tooltip content={<ChartTooltip />} />
          {categories.map((cat, i) => (
            <Area
              key={cat}
              type="monotone"
              dataKey={cat}
              stroke={COLORS[i % COLORS.length]}
              strokeWidth={2}
              fill={`url(#af-area-${cat})`}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 0 }}
            />
          ))}
        </RechartsAreaChart>
      </ResponsiveContainer>
    </div>
  );
}
