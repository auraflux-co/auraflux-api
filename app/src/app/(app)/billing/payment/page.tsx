'use client';
/**
 * /billing/payment — Native payment method management + invoice history (CPD-336)
 *
 * - Shows current card on file (brand, last4, expiry)
 * - Inline card update via Stripe Elements (stays on app.auraflux.co)
 * - Invoice list with download links
 */

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { loadStripe } from '@stripe/stripe-js';
import {
  Elements,
  CardElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import { formatUserError } from '@/lib/job-labels';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import {
  getPaymentMethod,
  createSetupIntent,
  updatePaymentMethod,
  getInvoices,
  type PaymentMethod,
  type Invoice,
} from '@/lib/api';

const STRIPE_PK = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';
const stripePromise = STRIPE_PK ? loadStripe(STRIPE_PK) : null;

const CARD_ELEMENT_OPTIONS = {
  style: {
    base: {
      fontSize:        '14px',
      color:           '#09090b',
      fontFamily:      'inherit',
      '::placeholder': { color: '#71717a' },
    },
    invalid: { color: '#ef4444' },
  },
};

// ─── Card brand icon (text fallback) ─────────────────────────────────────────

function brandLabel(brand: string) {
  const map: Record<string, string> = {
    visa:       'Visa',
    mastercard: 'Mastercard',
    amex:       'Amex',
    discover:   'Discover',
    jcb:        'JCB',
    unionpay:   'UnionPay',
    diners:     'Diners',
  };
  return map[brand.toLowerCase()] ?? brand.charAt(0).toUpperCase() + brand.slice(1);
}

// ─── Update card form (inside Elements) ──────────────────────────────────────

function UpdateCardForm({
  clientSecret,
  onSuccess,
}: {
  clientSecret: string;
  onSuccess: () => void;
}) {
  const stripe   = useStripe();
  const elements = useElements();
  const { getToken } = useAuth();
  const [saving, setSaving]   = useState(false);
  const [error,  setError]    = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setError(null);
    setSaving(true);
    try {
      const card = elements.getElement(CardElement);
      if (!card) throw new Error('Card element not found');

      const { setupIntent, error: stripeErr } = await stripe.confirmCardSetup(clientSecret, {
        payment_method: { card },
      });

      if (stripeErr) throw new Error(stripeErr.message);
      if (!setupIntent?.payment_method) throw new Error('No payment method returned');

      const token = await getToken();
      const res = await updatePaymentMethod(
        setupIntent.payment_method as string,
        token ?? undefined,
      );
      if (!res.ok) throw new Error('Failed to save card');

      onSuccess();
    } catch (err: unknown) {
      setError(formatUserError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="rounded-md border border-border bg-background px-3 py-3">
        <CardElement options={CARD_ELEMENT_OPTIONS} />
      </div>
      {error && (
        <p className="af-caption text-destructive">{error}</p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={saving || !stripe}>
          {saving ? 'Saving…' : 'Save card'}
        </Button>
      </div>
    </form>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PaymentPage() {
  const { getToken, isLoaded } = useAuth();

  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null);
  const [invoices,      setInvoices]      = useState<Invoice[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState<string | null>(null);

  const [showUpdate,    setShowUpdate]    = useState(false);
  const [clientSecret,  setClientSecret]  = useState<string | null>(null);
  const [setupLoading,  setSetupLoading]  = useState(false);

  const load = useCallback(async () => {
    try {
      const token = await getToken();
      const [pmRes, invRes] = await Promise.all([
        getPaymentMethod(token ?? undefined),
        getInvoices(token ?? undefined),
      ]);
      setPaymentMethod(pmRes.paymentMethod);
      setInvoices(invRes.invoices ?? []);
    } catch (err: unknown) {
      setError(formatUserError(err));
    } finally {
      setLoading(false);
    }
  }, [getToken]);

  useEffect(() => {
    if (isLoaded) load();
  }, [isLoaded, load]);

  async function handleShowUpdate() {
    if (clientSecret) { setShowUpdate(true); return; }
    setSetupLoading(true);
    try {
      const token = await getToken();
      const res   = await createSetupIntent(token ?? undefined);
      setClientSecret(res.clientSecret);
      setShowUpdate(true);
    } catch (err: unknown) {
      setError(formatUserError(err));
    } finally {
      setSetupLoading(false);
    }
  }

  function handleCardSaved() {
    setShowUpdate(false);
    setClientSecret(null);
    setLoading(true);
    load();
  }

  function fmtAmount(cents: number, currency: string) {
    return new Intl.NumberFormat('en-US', {
      style:    'currency',
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  }

  function fmtDate(unixSec: number) {
    return new Date(unixSec * 1000).toLocaleDateString('en-US', {
      month: 'short',
      day:   'numeric',
      year:  'numeric',
    });
  }

  if (loading) return (
    <PageShell maxWidth="3xl">
      <PageHeader title="Payment method &amp; invoices" subtitle="Manage your card and download invoices." />
      <div className="space-y-3">
        {[1, 2].map((i) => (
          <div key={i} className="h-24 rounded-lg bg-muted animate-pulse" />
        ))}
      </div>
    </PageShell>
  );

  return (
    <PageShell maxWidth="3xl">
      <PageHeader
        title="Payment method &amp; invoices"
        subtitle="Manage your card and download invoices."
      />

      {error && (
        <p className="af-body text-destructive bg-destructive/10 rounded px-3 py-2">{error}</p>
      )}

      {/* ── Current card ──────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="af-h3">Payment method</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {paymentMethod ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-7 rounded border border-border bg-muted flex items-center justify-center">
                  <span className="text-[10px] font-bold tracking-tight">{brandLabel(paymentMethod.brand)}</span>
                </div>
                <div>
                  <p className="af-body font-medium">
                    {brandLabel(paymentMethod.brand)} ending in {paymentMethod.last4}
                  </p>
                  <p className="af-caption text-muted-foreground">
                    Expires {paymentMethod.expMonth}/{paymentMethod.expYear}
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleShowUpdate}
                disabled={setupLoading}
              >
                {setupLoading ? 'Loading…' : 'Update card'}
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <p className="af-body text-muted-foreground">No card on file.</p>
              <Button
                variant="outline"
                size="sm"
                onClick={handleShowUpdate}
                disabled={setupLoading}
              >
                {setupLoading ? 'Loading…' : 'Add card'}
              </Button>
            </div>
          )}

          {showUpdate && clientSecret && stripePromise && (
            <div className="pt-2 border-t border-border">
              <p className="af-label mb-3 text-muted-foreground">
                Enter your new card details below. We use Stripe to securely process payments — your card number never touches our servers.
              </p>
              <Elements stripe={stripePromise} options={{ clientSecret }}>
                <UpdateCardForm
                  clientSecret={clientSecret}
                  onSuccess={handleCardSaved}
                />
              </Elements>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Invoices ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="af-h3">Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <p className="af-body text-muted-foreground">No invoices yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 af-subhead">Date</th>
                    <th className="text-left py-2 af-subhead hidden sm:table-cell">Description</th>
                    <th className="text-right py-2 af-subhead">Amount</th>
                    <th className="text-center py-2 af-subhead">Status</th>
                    <th className="text-right py-2 af-subhead">PDF</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {invoices.map((inv) => (
                    <tr key={inv.id} className="hover:bg-muted/20 transition-colors">
                      <td className="py-2.5 af-caption whitespace-nowrap pr-4">
                        {fmtDate(inv.date)}
                      </td>
                      <td className="py-2.5 af-caption text-muted-foreground hidden sm:table-cell pr-4 max-w-[200px] truncate">
                        {inv.description ?? inv.number ?? '—'}
                      </td>
                      <td className="py-2.5 af-body text-right font-medium tabular-nums pr-4">
                        {fmtAmount(inv.amountPaid || inv.amountDue, inv.currency)}
                      </td>
                      <td className="py-2.5 text-center">
                        <Badge
                          variant={inv.status === 'paid' ? 'default' : inv.status === 'open' ? 'outline' : 'secondary'}
                          className="af-caption capitalize"
                        >
                          {inv.status}
                        </Badge>
                      </td>
                      <td className="py-2.5 text-right">
                        {inv.pdfUrl ? (
                          <a
                            href={inv.pdfUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="af-caption text-primary hover:underline"
                          >
                            Download
                          </a>
                        ) : inv.hostedUrl ? (
                          <a
                            href={inv.hostedUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="af-caption text-primary hover:underline"
                          >
                            View
                          </a>
                        ) : (
                          <span className="af-caption text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}
