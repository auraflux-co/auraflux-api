'use client';

/**
 * PortalStatus — sidebar showing per-portal validation state (CPD-47)
 *
 * Calls POST /collab/validate with the current spec and renders
 * a pass/fail list per portal with missing field suggestions.
 */

import { useEffect, useState, useTransition } from 'react';
import { useAuth } from '@/lib/clerk-compat';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { validateJobSpec, type ValidationResult } from '@/lib/api';

interface PortalStatusProps {
  spec: Record<string, unknown>;
  className?: string;
}

export function PortalStatus({ spec, className }: PortalStatusProps) {
  const { getToken } = useAuth();
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [isPending, startTransition] = useTransition();

  // Re-validate whenever the spec changes (debounced via useTransition)
  useEffect(() => {
    if (Object.keys(spec).length === 0) {
      setResult(null);
      return;
    }
    startTransition(async () => {
      try {
        const token = await getToken();
        const res = await validateJobSpec(spec, token ?? undefined);
        setResult(res);
      } catch {
        // Non-fatal — portal status is advisory
      }
    });
  }, [JSON.stringify(spec)]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!result && !isPending) {
    return (
      <Card className={cn('h-fit', className)}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Portal Status</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Provide job spec fields to see portal readiness.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn('h-fit', className)}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm">Portal Status</CardTitle>
          {result && (
            <OverallBadge overall={result.overall} />
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {isPending && (
          <p className="text-xs text-muted-foreground animate-pulse">Validating…</p>
        )}
        {result?.portals.map((portal, i) => (
          <div key={portal.portal}>
            {i > 0 && <Separator className="my-2" />}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium truncate">{portal.label}</span>
              <Badge
                variant={portal.ready ? 'default' : 'destructive'}
                className="text-[10px] shrink-0"
              >
                {portal.ready ? 'Ready' : `${portal.missing.length} missing`}
              </Badge>
            </div>
            {!portal.ready && portal.suggestions.slice(0, 3).map((s, j) => (
              <p key={j} className="text-[10px] text-muted-foreground mt-0.5 pl-1">
                • {s}
              </p>
            ))}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function OverallBadge({ overall }: { overall: ValidationResult['overall'] }) {
  const MAP = {
    pass:    { label: 'All ready',  variant: 'default'     } as const,
    partial: { label: 'Partial',    variant: 'secondary'   } as const,
    fail:    { label: 'Not ready',  variant: 'destructive' } as const,
  };
  const { label, variant } = MAP[overall];
  return <Badge variant={variant} className="text-[10px]">{label}</Badge>;
}
