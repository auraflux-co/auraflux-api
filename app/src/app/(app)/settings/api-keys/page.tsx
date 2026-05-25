'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth, useUser } from '@clerk/nextjs';
import { apiFetch } from '@/lib/api';
import { formatUserError } from '@/lib/job-labels';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { usePlan } from '@/contexts/plan-context';
import { PageShell, PageHeader } from '@/components/ui/page-shell';

const TIER_ALIASES: Record<string, string> = { diy: 'operate', dwy: 'guided', dfy: 'managed' };
function normaliseTier(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return TIER_ALIASES[raw] ?? raw;
}

function isOperatePlan(tier: string | null | undefined) {
  return tier === 'operate' || tier === 'custom';
}

interface ApiKey {
  id: string;
  key_prefix: string;
  name: string;
  plan_tier: string;
  created_at: string;
  last_used_at: string | null;
}

interface NewKeyResult {
  key: string;
  id: string;
  prefix: string;
  name: string;
  createdAt: string;
  warning: string;
}

export default function ApiKeysPage() {
  const { planTier, isLoading: planLoading } = usePlan();
  const { user } = useUser();
  const clerkPlanTier = normaliseTier(user?.publicMetadata?.planTier as string | undefined);
  const effectivePlan = planTier ?? clerkPlanTier;
  const canUseApiKeys = isOperatePlan(effectivePlan);

  const { isLoaded, getToken } = useAuth();
  const [keys, setKeys]               = useState<ApiKey[]>([]);
  const [loading, setLoading]         = useState(true);
  const [creating, setCreating]       = useState(false);
  const [newKeyName, setNewKeyName]   = useState('');
  const [newKeyResult, setNewKeyResult] = useState<NewKeyResult | null>(null);
  const [copied, setCopied]           = useState(false);
  const [revoking, setRevoking]       = useState<string | null>(null);
  const [error, setError]             = useState('');

  const loadKeys = useCallback(async () => {
    if (!isLoaded || !canUseApiKeys) return;
    try {
      const token = await getToken();
      const data = await apiFetch<{ ok: boolean; apiKeys: ApiKey[] }>('/account/api-keys', { token: token ?? undefined });
      setKeys(data.apiKeys || []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load API keys');
    } finally {
      setLoading(false);
    }
  }, [isLoaded, getToken, canUseApiKeys]);

  useEffect(() => {
    if (!isLoaded || planLoading) return;
    if (!canUseApiKeys) {
      setLoading(false);
      setError('');
      return;
    }
    loadKeys();
  }, [isLoaded, planLoading, canUseApiKeys, loadKeys]);

  async function handleCreate() {
    if (!newKeyName.trim()) { setError('Enter a name for this key'); return; }
    setCreating(true);
    setError('');
    try {
      const token = await getToken();
      const data = await apiFetch<NewKeyResult & { ok: boolean }>('/account/api-keys', {
        method: 'POST',
        body: JSON.stringify({ name: newKeyName }),
        token: token ?? undefined,
      });
      setNewKeyResult(data);
      setNewKeyName('');
      await loadKeys();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create key');
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(keyId: string) {
    if (!confirm('Revoke this API key? Any integrations using it will stop working immediately.')) return;
    setRevoking(keyId);
    try {
      const token = await getToken();
      await apiFetch<{ ok: boolean; revoked: boolean }>(`/account/api-keys/${keyId}`, {
        method: 'DELETE',
        token: token ?? undefined,
      });
      setKeys(prev => prev.filter(k => k.id !== keyId));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to revoke key');
    } finally {
      setRevoking(null);
    }
  }

  function copyKey(key: string) {
    navigator.clipboard.writeText(key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!isLoaded || loading || planLoading) return (
    <div className="text-sm text-muted-foreground animate-pulse">Loading…</div>
  );

  if (effectivePlan && !canUseApiKeys) return (
    <PageShell maxWidth="3xl">
      <PageHeader title="My API Keys" />
      <Card className="border-muted">
        <CardContent className="pt-6 space-y-2">
          <p className="af-label font-medium">Not available on your plan</p>
          <p className="af-body">
            API key access is available on the <strong>Operate</strong> plan for customers who
            integrate directly with the AuraFlux API. On {effectivePlan.charAt(0).toUpperCase() + effectivePlan.slice(1)},
            your operator submits and manages jobs on your behalf.
          </p>
          <p className="af-body">Contact your operator if you need programmatic access.</p>
        </CardContent>
      </Card>
    </PageShell>
  );

  return (
    <PageShell maxWidth="3xl">
      <PageHeader
        title="My API Keys"
        subtitle={<>Use API keys to authenticate requests to <code className="af-caption bg-muted px-1 py-0.5 rounded">https://api.auraflux.co/v1/</code>. Keys are shown once at creation — store them securely.</>}
      />

      {/* New key reveal */}
      {newKeyResult && (
        <Card className="border-green-500/40 bg-green-50 dark:bg-green-950/20">
          <CardContent className="pt-4 space-y-3">
            <p className="text-sm font-medium text-green-700 dark:text-green-400">✓ Key created — copy it now</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-background border border-border rounded px-3 py-2 text-sm break-all font-mono text-green-700 dark:text-green-300">
                {newKeyResult.key}
              </code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyKey(newKeyResult.key)}
              >
                {copied ? 'Copied!' : 'Copy'}
              </Button>
            </div>
            <p className="af-caption text-yellow-600 dark:text-yellow-400">{newKeyResult.warning}</p>
            <button
              onClick={() => setNewKeyResult(null)}
              className="af-caption hover:text-foreground"
            >
              Dismiss
            </button>
          </CardContent>
        </Card>
      )}

      {/* Create form */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="af-subhead">Create new API key</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label className="af-caption">Key name</Label>
            <div className="flex gap-2">
              <Input
                placeholder="e.g. Production bot"
                value={newKeyName}
                onChange={e => setNewKeyName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreate()}
                className="h-8 text-sm"
              />
              <Button
                size="sm"
                onClick={handleCreate}
                disabled={creating}
              >
                {creating ? 'Creating…' : 'Create key'}
              </Button>
            </div>
          </div>
          {error && <p className="af-caption text-destructive">{formatUserError(error)}</p>}
        </CardContent>
      </Card>

      {/* Keys list */}
      <div className="space-y-2">
        <h2 className="af-subhead">Active keys</h2>
        {keys.length === 0 ? (
          <p className="af-body">No API keys yet. Create one above to get started.</p>
        ) : (
          <Card>
            <CardContent className="p-0">
              {keys.map((k, i) => (
                <div key={k.id}>
                  {i > 0 && <Separator />}
                  <div className="flex items-center justify-between px-4 py-3">
                    <div className="space-y-0.5 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="af-label font-medium">{k.name || 'Unnamed key'}</span>
                        <code className="af-caption font-mono">{k.key_prefix}…</code>
                        <Badge variant="outline" className="af-caption capitalize">{k.plan_tier}</Badge>
                      </div>
                      <p className="af-caption">
                        Created {new Date(k.created_at).toLocaleDateString()}
                        {k.last_used_at && ` · Last used ${new Date(k.last_used_at).toLocaleDateString()}`}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleRevoke(k.id)}
                      disabled={revoking === k.id}
                      className="text-destructive hover:text-destructive hover:bg-destructive/10 shrink-0"
                    >
                      {revoking === k.id ? 'Revoking…' : 'Revoke'}
                    </Button>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Docs callout */}
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="pt-4 space-y-1">
          <p className="af-label font-medium">Using the API</p>
          <p className="af-body">
            Authenticate every request with:{' '}
            <code className="af-caption bg-background border border-border rounded px-1 py-0.5">Authorization: Bearer af_live_…</code>
          </p>
          <p className="af-body">
            Base URL:{' '}
            <code className="af-caption bg-background border border-border rounded px-1 py-0.5">https://api.auraflux.co/v1/</code>
          </p>
          <a
            href="/developer"
            className="inline-block mt-1 af-label text-primary hover:underline"
          >
            View full API reference →
          </a>
        </CardContent>
      </Card>
    </PageShell>
  );
}
