'use client';
/**
 * VideoUpload — drag-and-drop video file uploader (CPD-116).
 * Uploads to POST /upload/video, calls onUploaded with the storage key.
 */

import { useCallback, useRef, useState } from 'react';
import { useAuth } from '@/lib/clerk-compat';
import { cn } from '@/lib/utils';

const API_BASE       = process.env.NEXT_PUBLIC_API_BASE || 'https://auraflux-api.onrender.com';
const ACCEPTED_TYPES = '.mp4,.mov,.avi,.webm,.mkv,.m4v';
const MAX_GB         = 2;

interface Props {
  onUploaded:   (key: string, fileName: string) => void;
  onClear?:     () => void;
  uploadedKey?: string | null;
  uploadedName?: string | null;
}

function fmt(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function VideoUpload({ onUploaded, onClear, uploadedKey, uploadedName }: Props) {
  const { getToken }                = useAuth();
  const inputRef                    = useRef<HTMLInputElement>(null);
  const [dragging,  setDragging]    = useState(false);
  const [progress,  setProgress]    = useState<number | null>(null);
  const [error,     setError]       = useState<string | null>(null);
  const [fileName,  setFileName]    = useState<string | null>(uploadedName ?? null);
  const [fileSize,  setFileSize]    = useState<number | null>(null);

  const uploadFile = useCallback(async (file: File) => {
    setError(null);

    if (file.size > MAX_GB * 1024 * 1024 * 1024) {
      setError(`File too large. Maximum size is ${MAX_GB} GB.`);
      return;
    }

    setFileName(file.name);
    setFileSize(file.size);
    setProgress(0);

    try {
      const token = await getToken();
      const form  = new FormData();
      form.append('file', file);

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_BASE}/upload/video`);
        if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
        };

        xhr.onload = () => {
          let body: { ok?: boolean; key?: string; error?: string } = {};
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            reject(new Error(`Upload failed (${xhr.status}) — unexpected server response`));
            return;
          }
          if (xhr.status === 200 && body.ok) {
            setProgress(100);
            onUploaded(body.key!, file.name);
            resolve();
          } else {
            reject(new Error(body.error || `Upload failed (${xhr.status})`));
          }
        };

        xhr.onerror   = () => reject(new Error('Network error during upload'));
        xhr.ontimeout = () => reject(new Error('Upload timed out — check your connection and try again'));
        xhr.timeout   = 5 * 60 * 1000; // 5-minute hard timeout
        xhr.send(form);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setProgress(null);
      setFileName(null);
    }
  }, [getToken, onUploaded]);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  }

  function onInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
    e.target.value = '';
  }

  // Already uploaded — show success state
  if (uploadedKey) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <svg className="shrink-0 text-emerald-500" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{uploadedName || 'Video uploaded'}</p>
            <p className="text-xs text-muted-foreground truncate">{uploadedKey}</p>
          </div>
        </div>
        {onClear && (
          <button
            onClick={onClear}
            className="shrink-0 text-xs text-muted-foreground hover:text-destructive transition-colors"
          >
            Remove
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Drop zone */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => e.key === 'Enter' && inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-10 cursor-pointer transition-colors select-none',
          dragging
            ? 'border-primary bg-primary/5'
            : 'border-border hover:border-primary/50 hover:bg-accent/30',
          progress !== null && progress < 100 && 'pointer-events-none opacity-70',
        )}
      >
        {progress !== null && progress < 100 ? (
          <>
            <svg className="text-primary animate-spin" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            <div className="w-full max-w-xs">
              <div className="h-1.5 rounded-full bg-border overflow-hidden">
                <div className="h-full bg-primary rounded-full transition-all duration-200" style={{ width: `${progress}%` }} />
              </div>
              <p className="text-xs text-muted-foreground text-center mt-1.5">
                Uploading {fileName} — {progress}%
              </p>
            </div>
          </>
        ) : (
          <>
            <svg className="text-muted-foreground" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <div className="text-center">
              <p className="text-sm font-medium">Drop your video here</p>
              <p className="text-xs text-muted-foreground mt-0.5">or click to browse your computer</p>
            </div>
            <p className="text-xs text-muted-foreground">MP4, MOV, AVI, WebM · up to {MAX_GB} GB</p>
          </>
        )}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        className="hidden"
        onChange={onInputChange}
      />

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
