"""
lib_gemini.py — Gemini API helper for E2E customer-brain tests.

Usage:
  from lib_gemini import ask_gemini
  response = ask_gemini("You are a customer. Given this brief: ...", model="gemini-2.5-flash")
"""

import json
import os
import re
import urllib.error
import urllib.request

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"


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
