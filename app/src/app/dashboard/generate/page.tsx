'use client';
/**
 * /dashboard/generate — AI video generation via Wan / RunPod (CPD-5)
 *
 * Sends a text prompt to POST /api/generate-video, then polls
 * GET /api/generate-video/:promptId every 5 s until success or error.
 */

import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { useRole } from '@/hooks/use-role';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { generateVideo, pollVideoStatus, type GenerateVideoResult } from '@/lib/api';

type GenStatus = 'idle' | 'queued' | 'running' | 'success' | 'error';

export default function GeneratePage() {
  const router = useRouter();
  const { isOperator, isLoaded } = useRole();
  const { getToken } = useAuth();

  useEffect(() => {
    if (isLoaded && !isOperator) router.replace('/dashboard');
  }, [isLoaded, isOperator, router]);

  const [prompt, setPrompt]         = useState('');
  const [numFrames, setNumFrames]   = useState(25);
  const [width, setWidth]           = useState(832);
  const [height, setHeight]         = useState(480);
  const [status, setStatus]         = useState<GenStatus>('idle');
  const [promptId, setPromptId]     = useState<string | null>(null);
  const [files, setFiles]           = useState<{ filename: string; url: string }[]>([]);
  const [error, setError]           = useState<string | null>(null);
  const pollTimer                   = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }

  async function startPolling(id: string, token: string | null) {
    pollTimer.current = setInterval(async () => {
      try {
        const res: GenerateVideoResult = await pollVideoStatus(id, token ?? undefined);
        if (res.status === 'success') {
          stopPolling();
          setFiles(res.files ?? []);
          setStatus('success');
        } else if (res.status === 'error') {
          stopPolling();
          setError(res.error ?? 'Generation failed');
          setStatus('error');
        } else {
          setStatus('running');
        }
      } catch (e) {
        stopPolling();
        setError(e instanceof Error ? e.message : 'Poll failed');
        setStatus('error');
      }
    }, 5000);
  }

  async function handleGenerate() {
    if (!prompt.trim()) return;
    stopPolling();
    setStatus('queued');
    setFiles([]);
    setError(null);
    setPromptId(null);

    try {
      const token = await getToken();
      const res = await generateVideo(
        { prompt: prompt.trim(), numFrames, width, height },
        token ?? undefined,
      );
      setPromptId(res.promptId);
      setStatus('queued');
      startPolling(res.promptId, token);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to queue');
      setStatus('error');
    }
  }

  if (!isLoaded || !isOperator) return null;

  const isGenerating = status === 'queued' || status === 'running';

  const statusBadge: Record<GenStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
    idle:    { label: 'Ready',     variant: 'outline' },
    queued:  { label: 'Queued…',   variant: 'secondary' },
    running: { label: 'Running…',  variant: 'secondary' },
    success: { label: 'Done',      variant: 'default' },
    error:   { label: 'Error',     variant: 'destructive' },
  };
  const badge = statusBadge[status];

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Generate Video</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Create a short AI video clip from a text prompt via Wan / RunPod.
        </p>
      </div>

      {/* Prompt input */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Prompt</CardTitle>
          <CardDescription>Describe the video you want to generate.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="prompt">Text prompt</Label>
            <Input
              id="prompt"
              placeholder="A cinematic aerial shot of a city at night, neon reflections on wet streets…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={isGenerating}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="numFrames">Frames</Label>
              <Input
                id="numFrames"
                type="number"
                min={1}
                max={120}
                value={numFrames}
                onChange={(e) => setNumFrames(Number(e.target.value))}
                disabled={isGenerating}
              />
              <p className="text-xs text-muted-foreground">at 16 fps — 25=1.5s, 49=3s, 81=5s</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="width">Width</Label>
              <Input
                id="width"
                type="number"
                value={width}
                onChange={(e) => setWidth(Number(e.target.value))}
                disabled={isGenerating}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="height">Height</Label>
              <Input
                id="height"
                type="number"
                value={height}
                onChange={(e) => setHeight(Number(e.target.value))}
                disabled={isGenerating}
              />
            </div>
          </div>

          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={isGenerating}
              onClick={() => { setWidth(832); setHeight(480); setNumFrames(25); }}
            >
              16:9 · 1.5s
            </Button>
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={isGenerating}
              onClick={() => { setWidth(832); setHeight(480); setNumFrames(49); }}
            >
              16:9 · 3s
            </Button>
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={isGenerating}
              onClick={() => { setWidth(832); setHeight(480); setNumFrames(81); }}
            >
              16:9 · 5s
            </Button>
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={isGenerating}
              onClick={() => { setWidth(720); setHeight(1280); setNumFrames(49); }}
            >
              9:16 · 3s
            </Button>
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={handleGenerate} disabled={isGenerating || !prompt.trim()}>
              {isGenerating ? 'Generating…' : 'Generate'}
            </Button>
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {promptId && (
              <span className="text-xs text-muted-foreground font-mono">{promptId.slice(0, 8)}…</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Error */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="pt-4">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      {/* Video preview */}
      {files.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Output</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {files.map((f) => (
              <div key={f.filename} className="space-y-2">
                <video
                  src={f.url}
                  controls
                  autoPlay
                  loop
                  className="w-full rounded-md border border-border"
                />
                <p className="text-xs text-muted-foreground font-mono">{f.filename}</p>
                <a
                  href={f.url}
                  download={f.filename}
                  className="text-xs text-primary underline"
                >
                  Download
                </a>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Waiting state */}
      {isGenerating && (
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground animate-pulse">
              {status === 'queued'
                ? 'Job queued — waiting for RunPod to pick it up…'
                : 'RunPod is rendering your video. Polling every 5 s…'}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
