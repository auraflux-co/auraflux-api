import { cn } from '@/lib/utils';

/** Standard dashboard content width + vertical rhythm between header and sections. */
export function PageShell({
  children,
  className,
  narrow,
  wide,
}: {
  children: React.ReactNode;
  className?: string;
  /** Form-heavy pages (settings sub-pages, new job wizard). */
  narrow?: boolean;
  /** Wide tables or multi-column layouts (review queue). */
  wide?: boolean;
}) {
  return (
    <div
      className={cn(
        narrow ? 'max-w-2xl' : wide ? 'max-w-4xl' : 'max-w-3xl',
        'space-y-6',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  icon,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1
          className={cn(
            'text-2xl font-semibold',
            icon && 'flex items-center gap-2.5',
          )}
        >
          {icon}
          {title}
        </h1>
        {description && (
          <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
        )}
      </div>
      {actions ? <div className="flex items-center gap-2 shrink-0">{actions}</div> : null}
    </div>
  );
}
