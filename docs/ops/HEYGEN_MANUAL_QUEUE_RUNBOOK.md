# HeyGen Manual Queue Runbook

Use this when final editor-only actions are required (for example: Delivery style Auto-enhance + Avatar V).

## 1) Prepare input queue

You can use either CSV or JSONL.

CSV headers:

```
url,label,id,notes
https://app.heygen.com/create-v4/<id>?panel=scene,Segment 01,seg01,apply auto-enhance + avatar V
```

JSONL line format:

```json
{"url":"https://app.heygen.com/create-v4/<id>?panel=scene","label":"Segment 01","id":"seg01","notes":"apply auto-enhance + avatar V"}
```

## 2) Start queue session

```bash
npm run heygen:manual-queue -- --input path/to/queue.csv
```

Or JSONL:

```bash
npm run heygen:manual-queue -- --input path/to/queue.jsonl
```

The tool creates a state file at:

`output/heygen_manual_queue_state_<timestamp>.json`

## 3) Commands during session

- `open` or `n`: open current item URL in browser
- `done` or `d`: mark done, advance
- `skip` or `s`: mark skipped, advance
- `retry` or `r`: mark retry, advance
- `back` or `b`: move back one item
- `j <index>`: jump to a specific 0-based index
- `list` or `l`: show next 5
- `print` or `p`: show current
- `quit` or `q`: save and exit

## 4) Resume later

```bash
npm run heygen:manual-queue -- --resume output/heygen_manual_queue_state_<timestamp>.json
```

This preserves cursor position and history.

## 5) Manual download ingest (drop-zone workflow)

If you downloaded the edited HeyGen folders and dropped them into:

`tmp/manual_segments/<jobId>/`

run:

```bash
npm run manual:ingest -- <jobId>
```

What this does:

- validates `manifest.json`
- reports expected segment coverage
- flattens nested HeyGen folders to expected filenames
- prints the exact resume curl command

Safe preview mode:

```bash
npm run manual:ingest -- <jobId> --dry-run
```

Latest modified job folder shortcut:

```bash
npm run manual:ingest:latest
```

