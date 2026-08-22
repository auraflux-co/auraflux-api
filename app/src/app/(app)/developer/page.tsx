'use client';

/**
 * /developer — In-app API reference (CPD-337)
 *
 * Shows every endpoint available on the Operate plan with request/response
 * shapes, cURL examples pre-filled with the customer's actual API key,
 * and a quick-start guide.
 */

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/clerk-compat';
import { apiFetch } from '@/lib/api';
import { usePlan } from '@/contexts/plan-context';
import { PageShell, PageHeader } from '@/components/ui/page-shell';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const BASE_URL = 'https://api.auraflux.co/v1';
const PLACEHOLDER_KEY = 'af_live_YOUR_KEY_HERE';

// ── Syntax-highlighted code block with copy button ───────────────────────────
function CodeBlock({ code, lang = 'bash' }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <div className="relative group">
      <pre className={`language-${lang} bg-[#0d1117] text-[#e6edf3] text-xs rounded-md p-4 overflow-x-auto leading-relaxed`}>
        <code>{code}</code>
      </pre>
      <button
        onClick={copy}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] bg-white/10 hover:bg-white/20 text-white px-2 py-1 rounded"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  );
}

// ── Single endpoint card ──────────────────────────────────────────────────────
function Endpoint({
  method, path, title, description, credits, request, response, curl,
}: {
  method: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  path: string;
  title: string;
  description: string;
  credits?: string;
  request?: string;
  response: string;
  curl: string;
}) {
  const [open, setOpen] = useState(false);
  const methodColor: Record<string, string> = {
    GET:    'bg-blue-500/15 text-blue-400 border-blue-500/30',
    POST:   'bg-green-500/15 text-green-400 border-green-500/30',
    DELETE: 'bg-red-500/15 text-red-400 border-red-500/30',
    PATCH:  'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  };
  return (
    <div className="border border-border rounded-md overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 transition-colors"
      >
        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border font-mono shrink-0 ${methodColor[method]}`}>
          {method}
        </span>
        <code className="text-sm text-foreground/90 font-mono flex-1">{path}</code>
        <span className="text-sm text-muted-foreground hidden sm:block">{title}</span>
        {credits && <Badge variant="outline" className="text-[10px] shrink-0">{credits}</Badge>}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="border-t border-border px-4 py-4 space-y-4 bg-muted/20">
          <p className="text-sm text-muted-foreground">{description}</p>

          <div className="grid sm:grid-cols-2 gap-4">
            {request && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Request body</p>
                <CodeBlock code={request} lang="json" />
              </div>
            )}
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Response</p>
              <CodeBlock code={response} lang="json" />
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">cURL example</p>
            <CodeBlock code={curl} lang="bash" />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Section heading ───────────────────────────────────────────────────────────
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-semibold text-foreground border-b border-border pb-2">{title}</h2>
      {children}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function DeveloperPage() {
  const { isLoaded, getToken } = useAuth();
  const { planTier } = usePlan();
  const [apiKey, setApiKey] = useState<string | null>(null);

  const loadKey = useCallback(async () => {
    if (!isLoaded) return;
    try {
      const token = await getToken();
      const data = await apiFetch<{ ok: boolean; apiKeys: { key_prefix: string }[] }>(
        '/account/api-keys', { token: token ?? undefined }
      );
      if (data.apiKeys?.[0]) setApiKey(`${data.apiKeys[0].key_prefix}…`);
    } catch { /* silent — fall back to placeholder */ }
  }, [isLoaded, getToken]);

  useEffect(() => { loadKey(); }, [loadKey]);

  const key = apiKey ?? PLACEHOLDER_KEY;
  const authHeader = `Authorization: Bearer ${key}`;

  const curl = (method: string, path: string, body?: string) =>
    [
      `curl -X ${method} ${BASE_URL}${path} \\`,
      `  -H "${authHeader}" \\`,
      `  -H "Content-Type: application/json"`,
      body ? `  -d '${body}'` : null,
    ].filter(Boolean).join('\n');

  const isOperate = planTier === 'operate' || planTier === 'custom' || !planTier;

  return (
    <PageShell maxWidth="4xl">
      <PageHeader
        title="API Reference"
        subtitle={`Full reference for the AuraFlux API. Base URL: ${BASE_URL}`}
      />

      {/* Quick start */}
      <Card className="border-primary/20 bg-primary/5">
        <CardHeader className="pb-2"><CardTitle className="text-sm">Quick start</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Pass your API key as a Bearer token on every request. Get or create keys at{' '}
            <a href="/settings/api-keys" className="text-primary hover:underline">Settings → API Keys</a>.
          </p>
          <CodeBlock code={`curl ${BASE_URL}/account \\\n  -H "${authHeader}"`} />
        </CardContent>
      </Card>

      {/* Auth */}
      <Section title="Authentication">
        <Endpoint
          method="GET" path="/account" title="Get account info"
          description="Returns your account ID, plan tier, credit balance, and rate limit info. Use this to verify your key is working."
          response={JSON.stringify({ accountId: 'user_xxx', planTier: 'operate', credits: { balance: 47, included: 50, used: 3 } }, null, 2)}
          curl={curl('GET', '/account')}
        />
      </Section>

      {/* Jobs */}
      <Section title="Jobs">
        <Endpoint
          method="POST" path="/jobs" title="Submit a job"
          description="Submit a new video production job. Returns immediately with a jobId — poll GET /jobs/:id to track progress. Credits are deducted at submission."
          credits="1–3 credits"
          request={JSON.stringify({
            entry: 'fetch',
            url: 'https://clips.twitch.tv/your-clip',
            topic: 'Best CS2 plays this week',
            tone: 'hype',
            format: 'short',
            durationMins: 1,
            platforms: ['tiktok'],
            publishMode: 'immediate',
          }, null, 2)}
          response={JSON.stringify({ jobId: 'job_abc123', status: 'queued', creditCost: 1, balance: 46 }, null, 2)}
          curl={curl('POST', '/jobs', JSON.stringify({ entry: 'fetch', url: 'https://clips.twitch.tv/your-clip', topic: 'Best plays', format: 'short', platforms: ['tiktok'] }))}
        />

        <Endpoint
          method="GET" path="/jobs/:id" title="Get job status"
          description="Poll this endpoint after submitting a job. Status progresses: queued → running → complete (or failed). A complete job has an outputUrl."
          response={JSON.stringify({ jobId: 'job_abc123', status: 'complete', outputUrl: 'https://r2.auraflux.co/…/output.mp4', score: 94, platforms: ['tiktok'], createdAt: '2026-05-25T12:00:00Z' }, null, 2)}
          curl={curl('GET', '/jobs/job_abc123')}
        />

        <Endpoint
          method="GET" path="/jobs/:id/result" title="Get job result"
          description="Returns the full output for a completed job: video URL, thumbnail URL, publish copy, and per-platform publish results. Returns 202 if not yet complete."
          response={JSON.stringify({ jobId: 'job_abc123', status: 'complete', videoUrl: 'https://r2.auraflux.co/…/output.mp4', thumbnailUrl: 'https://r2.auraflux.co/…/thumb.jpg', publishCopy: { title: '…', description: '…', hashtags: ['#cs2'] }, platforms: [], completedAt: '2026-05-25T12:05:00Z' }, null, 2)}
          curl={curl('GET', '/jobs/job_abc123/result')}
        />

        <Endpoint
          method="GET" path="/jobs" title="List jobs"
          description="Returns your job history. Supports pagination and optional status filter."
          response={JSON.stringify({ jobs: [{ jobId: 'job_abc123', status: 'complete', createdAt: '…' }], limit: 20, offset: 0, count: 1 }, null, 2)}
          curl={`curl "${BASE_URL}/jobs?limit=20&offset=0&status=complete" \\\n  -H "${authHeader}"`}
        />

        <Endpoint
          method="DELETE" path="/jobs/:id" title="Cancel a job"
          description="Cancels a queued or running job. Cannot cancel jobs that are already complete, published, or failed."
          response={JSON.stringify({ jobId: 'job_abc123', status: 'cancelled' }, null, 2)}
          curl={curl('DELETE', '/jobs/job_abc123')}
        />

        <Endpoint
          method="POST" path="/jobs/:id/approve-publish" title="Approve staged job for publish"
          description="When a job is submitted with staging: true, it stops before Portal 5 (publish) for your review. Call this endpoint to approve and publish it."
          response={JSON.stringify({ jobId: 'job_abc123', status: 'publishing' }, null, 2)}
          curl={curl('POST', '/jobs/job_abc123/approve-publish')}
        />
      </Section>

      {/* Upload */}
      <Section title="Upload">
        <Endpoint
          method="POST" path="/upload" title="Upload your own video"
          description={`Upload a video file (MP4/MOV, max 500MB) to use as the source for a job. Returns a fileId — pass it to POST /jobs as entry: 'upload', fileId: '<id>'.`}
          response={JSON.stringify({ fileId: 'upload_xyz', filename: 'myclip.mp4', sizeBytes: 104857600, uploadedAt: '2026-05-25T12:00:00Z' }, null, 2)}
          curl={`curl -X POST ${BASE_URL}/upload \\\n  -H "${authHeader}" \\\n  -F "file=@/path/to/myclip.mp4"`}
        />
      </Section>

      {/* Templates */}
      <Section title="Templates">
        <Endpoint
          method="GET" path="/templates" title="List templates"
          description="Returns all saved templates for your account. Use a template's id in POST /jobs as fromTemplateId to submit a job with pre-set options."
          response={JSON.stringify({ templates: [{ id: 'tpl_abc', name: 'Weekly highlights', createdAt: '…' }] }, null, 2)}
          curl={curl('GET', '/templates')}
        />

        <Endpoint
          method="POST" path="/templates" title="Create a template"
          description="Save a job configuration as a reusable template."
          request={JSON.stringify({ name: 'Weekly highlights', contentType: 'clips', format: 'short', platforms: ['tiktok'], tone: 'hype' }, null, 2)}
          response={JSON.stringify({ id: 'tpl_abc', name: 'Weekly highlights', createdAt: '…' }, null, 2)}
          curl={curl('POST', '/templates', JSON.stringify({ name: 'Weekly highlights', contentType: 'clips', format: 'short', platforms: ['tiktok'] }))}
        />

        <Endpoint
          method="DELETE" path="/templates/:id" title="Delete a template"
          description="Permanently deletes a saved template. Jobs previously submitted from this template are unaffected."
          response={JSON.stringify({ deleted: true }, null, 2)}
          curl={curl('DELETE', '/templates/tpl_abc')}
        />
      </Section>

      {/* Schedule */}
      <Section title="Scheduling">
        <Endpoint
          method="GET" path="/schedule" title="List scheduled jobs"
          description="Returns upcoming scheduled jobs."
          response={JSON.stringify({ scheduled: [{ jobId: 'job_abc123', scheduledAt: '2026-05-26T09:00:00Z', status: 'scheduled' }] }, null, 2)}
          curl={curl('GET', '/schedule')}
        />

        <Endpoint
          method="PATCH" path="/jobs/:id/schedule" title="Schedule a job"
          description="Set or update the publish time for an existing job. Pass null to unschedule."
          request={JSON.stringify({ scheduledAt: '2026-05-26T09:00:00Z' }, null, 2)}
          response={JSON.stringify({ jobId: 'job_abc123', scheduledAt: '2026-05-26T09:00:00Z' }, null, 2)}
          curl={curl('PATCH', '/jobs/job_abc123/schedule', JSON.stringify({ scheduledAt: '2026-05-26T09:00:00Z' }))}
        />
      </Section>

      {/* Field reference */}
      <Section title="Field reference — POST /jobs">
        <Card>
          <CardContent className="pt-4">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border">
                  <th className="pb-2 pr-4 font-medium">Field</th>
                  <th className="pb-2 pr-4 font-medium">Type</th>
                  <th className="pb-2 pr-4 font-medium">Required</th>
                  <th className="pb-2 font-medium">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {[
                  ['entry', '"fetch" | "upload" | "compose" | "generate"', 'No (default: fetch)', 'How the source video is provided. fetch = URL, upload = uploaded file, compose = script-only, generate = AI video'],
                  ['url', 'string', 'If entry=fetch', 'Source video URL (Twitch clip, YouTube, direct MP4)'],
                  ['urls', 'string[]', 'No', 'Multiple source URLs for multi-clip jobs'],
                  ['fileId', 'string', 'If entry=upload', 'File ID returned by POST /upload'],
                  ['topic', 'string', 'No', 'Topic for the video (max 500 chars). Used for script generation and metadata.'],
                  ['tone', 'string', 'No', 'Voiceover tone e.g. "hype", "calm", "educational"'],
                  ['format', '"short" | "long"', 'No (default: short)', 'Short-form (≤60s) or long-form video'],
                  ['durationMins', 'number', 'No (default: 1)', 'Target duration in minutes (1–120)'],
                  ['platforms', 'string[]', 'No', '"tiktok", "youtube", "instagram" — platforms to publish to'],
                  ['publishMode', '"immediate" | "scheduled" | "manual"', 'No (default: immediate)', 'When to publish after production'],
                  ['staging', 'boolean', 'No', 'If true, job stops before publish for your review. Use GET /jobs/:id/staging-assets + POST /jobs/:id/approve-publish.'],
                  ['fromTemplateId', 'string', 'No', 'Start from a saved template. Body fields override template values.'],
                  ['addOns', 'object', 'No', 'Enable optional add-ons: { shoppable: { active: true } }'],
                ].map(([field, type, required, desc]) => (
                  <tr key={field as string}>
                    <td className="py-2 pr-4 font-mono text-foreground/90">{field}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{type}</td>
                    <td className="py-2 pr-4 text-muted-foreground">{required}</td>
                    <td className="py-2 text-muted-foreground">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </Section>

      {/* Rate limits & credits */}
      <Section title="Rate limits & credit costs">
        <Card>
          <CardContent className="pt-4 space-y-3 text-sm text-muted-foreground">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <p className="font-medium text-foreground">Rate limits</p>
                <ul className="space-y-1 text-xs">
                  <li>60 API requests / minute</li>
                  <li>10 concurrent job submissions</li>
                  <li>500MB max upload size</li>
                </ul>
              </div>
              <div className="space-y-2">
                <p className="font-medium text-foreground">Credit costs per job</p>
                <ul className="space-y-1 text-xs">
                  <li>Short-form, single clip — <strong>1 credit</strong></li>
                  <li>Long-form or multi-clip — <strong>2 credits</strong></li>
                  <li>Video generation (WAN) — <strong>3 credits</strong></li>
                </ul>
              </div>
            </div>
            <p className="text-xs">
              Check your balance with <code className="bg-muted px-1 py-0.5 rounded">GET /account</code>.
              Purchase additional credits on the{' '}
              <a href="/credits" className="text-primary hover:underline">Credits page</a>.
            </p>
          </CardContent>
        </Card>
      </Section>

      {/* Help */}
      <Card className="border-muted">
        <CardContent className="pt-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Need help with the API?</p>
            <p className="text-xs text-muted-foreground mt-0.5">Open a support request and we'll get back to you.</p>
          </div>
          <a href="/support">
            <Button variant="outline" size="sm">Contact support</Button>
          </a>
        </CardContent>
      </Card>
    </PageShell>
  );
}
