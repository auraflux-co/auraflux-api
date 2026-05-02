'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@clerk/nextjs';
import { apiFetch } from '@/lib/api';

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
    if (!isLoaded) return;
    try {
      const token = await getToken();
      const data = await apiFetch<{ ok: boolean; apiKeys: ApiKey[] }>('/account/api-keys', { token: token ?? undefined });
      setKeys(data.apiKeys || []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load API keys');
    } finally {
      setLoading(false);
    }
  }, [isLoaded, getToken]);

  useEffect(() => { loadKeys(); }, [loadKeys]);

  async function handleCreate() {
    if (!newKeyName.trim()) { setError('Enter a name for this key'); return; }
    setCreating(true);
    setError('');
    try {
      const token = await getToken();
      const data = await apiFetch<NewKeyResult & { ok: boolean }>('/account/api-keys', { method: 'POST', body: JSON.stringify({ name: newKeyName }), token: token ?? undefined });
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
      await apiFetch<{ ok: boolean; revoked: boolean }>(`/account/api-keys/${keyId}`, { method: 'DELETE', token: token ?? undefined });
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

  if (!isLoaded || loading) return (
    <div className="p-8 text-gray-400 animate-pulse">Loading API keys…</div>
  );

  return (
    <div className="p-6 max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-white">API Keys</h1>
        <p className="mt-1 text-sm text-gray-400">
          Use API keys to authenticate requests to{' '}
          <code className="text-indigo-400">https://api.auraflux.co/v1/</code>.
          Keys are shown once at creation — store them securely.
        </p>
      </div>

      {/* New key reveal */}
      {newKeyResult && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-950/30 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400 font-medium">✓ Key created — copy it now</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-black/40 rounded px-3 py-2 text-sm text-emerald-300 break-all font-mono">
              {newKeyResult.key}
            </code>
            <button
              onClick={() => copyKey(newKeyResult.key)}
              className="shrink-0 px-3 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <p className="text-xs text-amber-400">{newKeyResult.warning}</p>
          <button onClick={() => setNewKeyResult(null)} className="text-xs text-gray-500 hover:text-gray-300">
            Dismiss
          </button>
        </div>
      )}

      {/* Create form */}
      <div className="rounded-lg border border-white/10 bg-white/5 p-5 space-y-4">
        <h2 className="text-sm font-medium text-white">Create new API key</h2>
        <div className="flex gap-3">
          <input
            type="text"
            placeholder="e.g. Production bot"
            value={newKeyName}
            onChange={e => setNewKeyName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            className="flex-1 rounded bg-black/30 border border-white/10 px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500"
          />
          <button
            onClick={handleCreate}
            disabled={creating}
            className="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-medium"
          >
            {creating ? 'Creating…' : 'Create key'}
          </button>
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>

      {/* Keys list */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-gray-400">Active keys</h2>
        {keys.length === 0 ? (
          <p className="text-sm text-gray-500">No API keys yet. Create one above to get started.</p>
        ) : (
          <div className="divide-y divide-white/5 rounded-lg border border-white/10 overflow-hidden">
            {keys.map(k => (
              <div key={k.id} className="flex items-center justify-between px-4 py-3 bg-white/[0.03] hover:bg-white/[0.06] transition-colors">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-white font-medium">{k.name || 'Unnamed key'}</span>
                    <code className="text-xs text-gray-500 font-mono">{k.key_prefix}…</code>
                  </div>
                  <div className="text-xs text-gray-500">
                    Created {new Date(k.created_at).toLocaleDateString()}
                    {k.last_used_at && ` · Last used ${new Date(k.last_used_at).toLocaleDateString()}`}
                  </div>
                </div>
                <button
                  onClick={() => handleRevoke(k.id)}
                  disabled={revoking === k.id}
                  className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50 px-2 py-1 rounded hover:bg-red-950/30"
                >
                  {revoking === k.id ? 'Revoking…' : 'Revoke'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Docs callout */}
      <div className="rounded-lg border border-indigo-500/20 bg-indigo-950/20 p-4 text-sm text-gray-400 space-y-1">
        <p className="text-indigo-300 font-medium">Using the API</p>
        <p>Authenticate every request with: <code className="text-indigo-400">Authorization: Bearer af_live_…</code></p>
        <p>Base URL: <code className="text-indigo-400">https://api.auraflux.co/v1/</code></p>
        <a
          href="https://robertsworkspace-18914505.atlassian.net/wiki/spaces/CP/pages/8192001"
          target="_blank" rel="noopener noreferrer"
          className="inline-block mt-1 text-indigo-400 hover:text-indigo-300 underline"
        >
          View full API documentation →
        </a>
      </div>
    </div>
  );
}
