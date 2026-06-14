'use client';
/**
 * /generate/canva — Canva AI Design Generator (superadmin only)
 *
 * All 32 Canva MCP design types surfaced as a self-service UI.
 * Prompts are sent to POST /admin/canva-generate (Anthropic + Canva MCP).
 * Selected candidates are saved via POST /admin/canva-save.
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';
import { useRole } from '@/hooks/use-role';
import { Button }      from '@/components/ui/button';
import { Textarea }    from '@/components/ui/textarea';
import { Label }       from '@/components/ui/label';
import { Badge }       from '@/components/ui/badge';
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from '@/components/ui/card';
import {
  canvaGenerate,
  canvaSave,
  type CanvaDesignType,
  type CanvaCandidate,
} from '@/lib/api';

// ─── Design type catalogue ────────────────────────────────────────────────────

const DESIGN_TYPES: { value: CanvaDesignType; label: string; group: string }[] = [
  // Social
  { value: 'instagram_post',  label: 'Instagram Post',   group: 'Social' },
  { value: 'facebook_post',   label: 'Facebook Post',    group: 'Social' },
  { value: 'facebook_cover',  label: 'Facebook Cover',   group: 'Social' },
  { value: 'twitter_post',    label: 'Twitter / X Post', group: 'Social' },
  { value: 'pinterest_pin',   label: 'Pinterest Pin',    group: 'Social' },
  { value: 'your_story',      label: 'Story (IG/FB)',    group: 'Social' },
  // YouTube
  { value: 'youtube_thumbnail', label: 'YouTube Thumbnail', group: 'YouTube' },
  { value: 'youtube_banner',    label: 'YouTube Banner',    group: 'YouTube' },
  // Print / Promo
  { value: 'poster',          label: 'Poster',           group: 'Print & Promo' },
  { value: 'flyer',           label: 'Flyer',            group: 'Print & Promo' },
  { value: 'postcard',        label: 'Postcard',         group: 'Print & Promo' },
  { value: 'invitation',      label: 'Invitation',       group: 'Print & Promo' },
  { value: 'business_card',   label: 'Business Card',    group: 'Print & Promo' },
  { value: 'photo_collage',   label: 'Photo Collage',    group: 'Print & Promo' },
  // Brand & Identity
  { value: 'logo',            label: 'Logo',             group: 'Brand & Identity' },
  { value: 'infographic',     label: 'Infographic',      group: 'Brand & Identity' },
  { value: 'email',           label: 'Email Newsletter', group: 'Brand & Identity' },
  // Presentations & Docs
  { value: 'presentation',    label: 'Presentation',     group: 'Presentations & Docs' },
  { value: 'proposal',        label: 'Proposal',         group: 'Presentations & Docs' },
  { value: 'report',          label: 'Report',           group: 'Presentations & Docs' },
  { value: 'doc',             label: 'Canva Doc',        group: 'Presentations & Docs' },
  { value: 'document',        label: 'Document',         group: 'Presentations & Docs' },
  // Personal / Other
  { value: 'card',            label: 'Card',             group: 'Other' },
  { value: 'resume',          label: 'Resume',           group: 'Other' },
  { value: 'desktop_wallpaper', label: 'Desktop Wallpaper', group: 'Other' },
  { value: 'phone_wallpaper', label: 'Phone Wallpaper',  group: 'Other' },
];

type GenStatus = 'idle' | 'generating' | 'done' | 'error';
type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

interface SavedDesign {
  candidateId: string;
  designUrl:   string;
}

export default function CanvaGeneratePage() {
  const router               = useRouter();
  const { isSuperAdmin, isLoaded } = useRole();
  const { getToken }         = useAuth();

  useEffect(() => {
    if (isLoaded && !isSuperAdmin) router.replace('/home');
  }, [isLoaded, isSuperAdmin, router]);

  const [prompt, setPrompt]           = useState('');
  const [designType, setDesignType]   = useState<CanvaDesignType>('poster');
  const [status, setStatus]           = useState<GenStatus>('idle');
  const [error, setError]             = useState<string | null>(null);
  const [jobId, setJobId]             = useState<string | null>(null);
  const [candidates, setCandidates]   = useState<CanvaCandidate[]>([]);
  const [saveStatus, setSaveStatus]   = useState<Record<string, SaveStatus>>({});
  const [saved, setSaved]             = useState<Record<string, SavedDesign>>({});

  if (!isLoaded || !isSuperAdmin) return null;

  // ── Generate ───────────────────────────────────────────────────
  async function handleGenerate() {
    if (!prompt.trim()) return;
    setStatus('generating');
    setError(null);
    setCandidates([]);
    setJobId(null);
    setSaveStatus({});
    setSaved({});

    try {
      const token = await getToken();
      const result = await canvaGenerate(prompt.trim(), designType, token ?? undefined);
      setJobId(result.jobId);
      setCandidates(result.candidates);
      setStatus('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed');
      setStatus('error');
    }
  }

  // ── Save candidate ─────────────────────────────────────────────
  async function handleSave(candidate: CanvaCandidate) {
    if (!jobId) return;
    setSaveStatus(prev => ({ ...prev, [candidate.candidate_id]: 'saving' }));

    try {
      const token  = await getToken();
      const result = await canvaSave(jobId, candidate.candidate_id, token ?? undefined);
      setSaved(prev => ({ ...prev, [candidate.candidate_id]: {
        candidateId: candidate.candidate_id,
        designUrl:   result.designUrl,
      }}));
      setSaveStatus(prev => ({ ...prev, [candidate.candidate_id]: 'saved' }));
    } catch (e) {
      setSaveStatus(prev => ({ ...prev, [candidate.candidate_id]: 'error' }));
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  const isGenerating = status === 'generating';

  const genBadge = {
    idle:       { label: 'Ready',        variant: 'outline'      },
    generating: { label: 'Generating…',  variant: 'secondary'    },
    done:       { label: 'Done',         variant: 'default'      },
    error:      { label: 'Error',        variant: 'destructive'  },
  } as const;

  // Group design types for the select
  const groups = [...new Set(DESIGN_TYPES.map(d => d.group))];

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Canva Image Generator</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Generate designs via Canva AI — pick a type, enter your prompt, and save candidates to your Canva account.
        </p>
      </div>

      {/* Prompt + controls */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Design prompt</CardTitle>
          <CardDescription>
            Describe what you want to create. Include style, colours, tone, and any specific details.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Design type */}
          <div className="space-y-1.5">
            <Label htmlFor="design-type">Design type</Label>
            <select
              id="design-type"
              value={designType}
              onChange={(e) => setDesignType(e.target.value as CanvaDesignType)}
              disabled={isGenerating}
              className="w-64 h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm
                         focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              {groups.map(group => (
                <optgroup key={group} label={group}>
                  {DESIGN_TYPES.filter(d => d.group === group).map(dt => (
                    <option key={dt.value} value={dt.value}>{dt.label}</option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {/* Prompt text area */}
          <div className="space-y-1.5">
            <Label htmlFor="prompt">Prompt</Label>
            <Textarea
              id="prompt"
              placeholder="e.g. AuraFlux plan comparison — Deep Space Navy background, Luminous Gold accents, modern sans-serif, 3 columns for Operate / Guided / Managed…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={isGenerating}
              rows={4}
              className="resize-none"
            />
          </div>

          {/* Quick prompt chips */}
          <div className="flex flex-wrap gap-2">
            {[
              'AuraFlux Operate plan — navy & gold, modern minimal',
              'AuraFlux Guided plan — professional, trust-building tone',
              'AuraFlux Managed plan — premium enterprise feel',
              'Extra Credits add-on — energetic, reward-style visual',
            ].map(chip => (
              <Button
                key={chip}
                size="sm"
                variant="outline"
                type="button"
                disabled={isGenerating}
                onClick={() => setPrompt(chip)}
                className="text-xs h-7"
              >
                {chip.split('—')[0].trim()}
              </Button>
            ))}
          </div>

          {/* Generate button + status */}
          <div className="flex items-center gap-3">
            <Button
              onClick={handleGenerate}
              disabled={isGenerating || !prompt.trim()}
            >
              {isGenerating ? 'Generating…' : 'Generate'}
            </Button>
            <Badge variant={genBadge[status].variant as 'outline' | 'secondary' | 'default' | 'destructive'}>
              {genBadge[status].label}
            </Badge>
            {candidates.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {candidates.length} candidate{candidates.length !== 1 ? 's' : ''}
              </span>
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

      {/* Generating spinner */}
      {isGenerating && (
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground animate-pulse">
              Asking Canva AI to generate your design… this can take 20–60 seconds.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Candidates grid */}
      {candidates.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-base font-medium">Candidates — click to open in Canva, or save to your account</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {candidates.map((c, i) => {
              const ss = saveStatus[c.candidate_id] ?? 'idle';
              const sd = saved[c.candidate_id];
              return (
                <Card key={c.candidate_id} className="overflow-hidden">
                  {/* Thumbnail */}
                  <div className="bg-muted aspect-video flex items-center justify-center overflow-hidden">
                    {c.thumbnail_url ? (
                      <img
                        src={c.thumbnail_url}
                        alt={`Candidate ${i + 1}`}
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <span className="text-muted-foreground text-sm">No preview</span>
                    )}
                  </div>

                  <CardContent className="pt-3 pb-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-muted-foreground">
                        Candidate {i + 1}
                      </span>
                      <span className="text-xs font-mono text-muted-foreground/60">
                        {c.candidate_id.slice(0, 8)}…
                      </span>
                    </div>

                    <div className="flex gap-2">
                      {/* Open in Canva */}
                      {c.design_url && (
                        <a
                          href={c.design_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-1"
                        >
                          <Button size="sm" variant="outline" className="w-full text-xs">
                            Open in Canva
                          </Button>
                        </a>
                      )}

                      {/* Save to account */}
                      {ss === 'saved' && sd ? (
                        <a
                          href={sd.designUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex-1"
                        >
                          <Button size="sm" className="w-full text-xs bg-emerald-600 hover:bg-emerald-700">
                            ✓ Saved — Open
                          </Button>
                        </a>
                      ) : (
                        <Button
                          size="sm"
                          className="flex-1 text-xs"
                          disabled={ss === 'saving'}
                          onClick={() => handleSave(c)}
                        >
                          {ss === 'saving' ? 'Saving…' : ss === 'error' ? 'Retry save' : 'Save to Canva'}
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
