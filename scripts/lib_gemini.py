"""
lib_gemini.py — Gemini API helper for E2E customer-brain tests.

Usage:
  from lib_gemini import ask_gemini, ask_gemini_video
  response     = ask_gemini("You are a customer. Given this brief: ...")
  video_result = ask_gemini_video("https://assets.auraflux.co/outputs/...", prompt)
"""

import base64
import json
import os
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_BASE    = "https://generativelanguage.googleapis.com/v1beta/models"
FILES_BASE     = "https://generativelanguage.googleapis.com/upload/v1beta/files"
FILES_GET_BASE = "https://generativelanguage.googleapis.com/v1beta/files"


def ask_gemini(prompt: str, model: str = "gemini-2.5-flash", json_mode: bool = False) -> str:
    """
    Send a single-turn prompt to Gemini and return the text response.

    If json_mode=True, instructs the model to return only valid JSON and
    strips any markdown code fences before returning.
    """
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY not set")

    system = (
        "You must respond with valid JSON only — no markdown, no commentary, no code fences."
        if json_mode
        else None
    )

    contents = [{"role": "user", "parts": [{"text": prompt}]}]
    body: dict = {"contents": contents}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    if json_mode:
        body["generationConfig"] = {"responseMimeType": "application/json"}

    url = f"{GEMINI_BASE}/{model}:generateContent?key={GEMINI_API_KEY}"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Gemini HTTP {e.code}: {e.read().decode()[:200]}") from e

    text = data["candidates"][0]["content"]["parts"][0]["text"].strip()

    if json_mode:
        # Strip accidental code fences robustly — handles leading spaces, language tags,
        # multiple fences, and edge cases Gemini 2.5 occasionally produces.
        text = re.sub(r'^\s*```[a-zA-Z]*\n?', '', text)
        text = re.sub(r'\n?```\s*$', '', text)
        text = text.strip()

    return text


def ask_gemini_json(prompt: str, model: str = "gemini-2.5-flash") -> dict:
    """Convenience wrapper — returns parsed JSON dict."""
    raw = ask_gemini(prompt, model=model, json_mode=True)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Gemini returned invalid JSON: {e}\nRaw response: {raw[:400]}") from e


# ── Video understanding via Gemini Files API ──────────────────────────────────

def _download_video(url: str) -> str:
    """Download a video URL to a temp file. Returns temp file path."""
    suffix = ".mp4"
    if ".webm" in url:
        suffix = ".webm"
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    tmp.close()
    req = urllib.request.Request(url, headers={"User-Agent": "AuraFlux-E2E/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        with open(tmp.name, "wb") as f:
            while True:
                chunk = r.read(1024 * 256)
                if not chunk:
                    break
                f.write(chunk)
    return tmp.name


def _upload_to_gemini_files(local_path: str, mime: str = "video/mp4") -> str:
    """
    Upload a local video file to the Gemini Files API.
    Returns the file URI (e.g. 'https://generativelanguage.googleapis.com/v1beta/files/xxx').
    """
    size = os.path.getsize(local_path)
    display_name = os.path.basename(local_path)

    # Step 1 — initiate resumable upload
    meta = json.dumps({"file": {"display_name": display_name}}).encode()
    init_req = urllib.request.Request(
        f"{FILES_BASE}?key={GEMINI_API_KEY}",
        data=meta,
        headers={
            "X-Goog-Upload-Protocol":            "resumable",
            "X-Goog-Upload-Command":             "start",
            "X-Goog-Upload-Header-Content-Length": str(size),
            "X-Goog-Upload-Header-Content-Type": mime,
            "Content-Type":                       "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(init_req, timeout=30) as r:
        upload_url = r.headers.get("X-Goog-Upload-URL")

    if not upload_url:
        raise RuntimeError("Gemini Files API did not return an upload URL")

    # Step 2 — upload content in one shot
    with open(local_path, "rb") as f:
        data = f.read()

    upload_req = urllib.request.Request(
        upload_url,
        data=data,
        headers={
            "Content-Length":         str(size),
            "X-Goog-Upload-Offset":   "0",
            "X-Goog-Upload-Command":  "upload, finalize",
        },
        method="POST",
    )
    with urllib.request.urlopen(upload_req, timeout=120) as r:
        file_info = json.loads(r.read())

    return file_info["file"]["uri"]


def _wait_for_file_active(file_uri: str, timeout: int = 120) -> None:
    """Poll the Files API until the file state is ACTIVE."""
    name = file_uri.split("/")[-1]
    deadline = time.time() + timeout
    while time.time() < deadline:
        req = urllib.request.Request(
            f"{FILES_GET_BASE}/{name}?key={GEMINI_API_KEY}",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            info = json.loads(r.read())
        state = info.get("state", "")
        if state == "ACTIVE":
            return
        if state == "FAILED":
            raise RuntimeError(f"Gemini file processing FAILED for {file_uri}")
        time.sleep(4)
    raise RuntimeError(f"Gemini file still not ACTIVE after {timeout}s: {file_uri}")


def ask_gemini_video(
    video_url: str,
    prompt: str,
    model: str = "gemini-2.5-flash",
    json_mode: bool = False,
) -> str:
    """
    Pass a video to Gemini for understanding.

    Downloads the video, uploads it to the Gemini Files API, waits for
    processing, then sends it with the prompt to the generateContent endpoint.

    Returns the model's text response (or JSON string if json_mode=True).
    """
    if not GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY not set")

    mime = "video/webm" if ".webm" in video_url else "video/mp4"
    local_path = None
    try:
        local_path = _download_video(video_url)
        file_uri   = _upload_to_gemini_files(local_path, mime=mime)
        _wait_for_file_active(file_uri)
    finally:
        if local_path and os.path.exists(local_path):
            os.unlink(local_path)

    system = (
        "You must respond with valid JSON only — no markdown, no commentary, no code fences."
        if json_mode
        else None
    )

    body: dict = {
        "contents": [{
            "role": "user",
            "parts": [
                {"fileData": {"mimeType": mime, "fileUri": file_uri}},
                {"text": prompt},
            ],
        }],
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    if json_mode:
        body["generationConfig"] = {"responseMimeType": "application/json"}

    url = f"{GEMINI_BASE}/{model}:generateContent?key={GEMINI_API_KEY}"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Gemini video HTTP {e.code}: {e.read().decode()[:300]}") from e

    text = data["candidates"][0]["content"]["parts"][0]["text"].strip()

    if json_mode:
        text = re.sub(r'^\s*```[a-zA-Z]*\n?', '', text)
        text = re.sub(r'\n?```\s*$', '', text)
        text = text.strip()

    return text


def ask_gemini_video_json(video_url: str, prompt: str, model: str = "gemini-2.5-flash") -> dict:
    """Convenience wrapper — watch video and return parsed JSON."""
    raw = ask_gemini_video(video_url, prompt, model=model, json_mode=True)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Gemini video returned invalid JSON: {e}\nRaw: {raw[:400]}") from e
