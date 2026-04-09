# HeyGen Job Monitoring & Tailing

Since HeyGen jobs run on external servers (not in our `server.js` process), you can't see their progress in the normal server logs. This tool bridges that gap by polling HeyGen's API and streaming updates to a log file you can tail.

## Quick Start

### Option 1: If you know the HeyGen video IDs

```bash
./tail_heygen.sh <video_id1> <video_id2> <video_id3>
```

Example:
```bash
./tail_heygen.sh abc123def456 xyz789abc123
```

### Option 2: Extract IDs from current job

After sending a script to HeyGen, check the server console output for video IDs, then:

```bash
./tail_heygen.sh abc123def456 xyz789abc123
```

## What You'll See

The monitor polls HeyGen every 10 seconds and logs status changes:

```
[2026-04-07T18:45:00.000Z] 🚀 Starting HeyGen monitor for 3 jobs: abc123, def456, ghi789
[2026-04-07T18:45:00.001Z] 📋 Log file: /Users/robertgregory/cwn-production/tmp/heygen_monitor.log
[2026-04-07T18:45:00.002Z] ⏱️  Polling every 10 seconds

[2026-04-07T18:45:01.234Z] ⏸️  abc123: Pending (1s in queue)
[2026-04-07T18:45:01.567Z] ⏸️  def456: Pending (1s in queue)
[2026-04-07T18:45:01.890Z] ⏸️  ghi789: Pending (1s in queue)

[2026-04-07T18:45:15.123Z] ⏳ abc123: Processing... (15s elapsed)
[2026-04-07T18:45:15.456Z] ⏳ def456: Processing... (15s elapsed)

[2026-04-07T18:46:30.789Z] ✅ abc123: COMPLETED (90s) - https://resource.heygen.ai/video/abc123.mp4
[2026-04-07T18:46:30.790Z]    Duration: 42s

[2026-04-07T18:47:00.123Z] ✅ def456: COMPLETED (120s) - https://resource.heygen.ai/video/def456.mp4
[2026-04-07T18:47:00.124Z]    Duration: 38s

[2026-04-07T18:47:15.456Z] ✅ ghi789: COMPLETED (135s) - https://resource.heygen.ai/video/ghi789.mp4
[2026-04-07T18:47:15.457Z]    Duration: 45s

[2026-04-07T18:47:15.500Z] 🏁 All jobs complete!
[2026-04-07T18:47:15.501Z] 📊 Final status:
[2026-04-07T18:47:15.502Z]    abc123: completed
[2026-04-07T18:47:15.503Z]    def456: completed
[2026-04-07T18:47:15.504Z]    ghi789: completed
```

## Status Indicators

- `⏸️  Pending`: Job is in HeyGen's queue
- `⏳ Processing`: HeyGen is rendering the video
- `✅ COMPLETED`: Video is ready (includes download URL)
- `❌ FAILED`: HeyGen encountered an error

## How to Get Video IDs

### Method 1: From Dashboard Job Queue
Look at the job queue in the dashboard UI - video IDs are displayed there

### Method 2: From Server Console
After sending to HeyGen, look for lines like:
```
[send-to-heygen] ✅ Scene 1: abc123def456
[send-to-heygen] ✅ Scene 2: xyz789abc123
```

### Method 3: From Server Log File
If you're logging to a file:
```bash
grep 'video_id' server.log | tail -20
```

## Manual Usage (without helper script)

```bash
# Start monitoring in background
node heygen_monitor.js abc123 def456 ghi789 &

# Tail the log
tail -f tmp/heygen_monitor.log
```

## Stop Monitoring

Press `Ctrl+C` to stop tailing the log.

The monitor process will auto-exit when all jobs complete or fail.

To kill a stuck monitor manually:
```bash
pkill -f heygen_monitor
```

## Log File Location

All output is written to:
```
/Users/robertgregory/cwn-production/tmp/heygen_monitor.log
```

## Integration with Server Pipeline

When you start a job that sends to HeyGen, the server will output the video IDs. Copy them and run:

```bash
./tail_heygen.sh <paste_video_ids_here>
```

Then you can watch the HeyGen jobs progress in real-time alongside your server logs.

## Troubleshooting

**Q: "No active HeyGen jobs found"**
A: You need to provide video IDs as arguments. Check the dashboard or server output.

**Q: "API error - 401 Unauthorized"**
A: Check that `HEYGEN_API_KEY` is set correctly in your `.env` file

**Q: Monitor exits immediately**
A: All jobs may have already completed. Check the log file to see final status.

**Q: Jobs stuck at "Processing" for a long time**
A: HeyGen video generation can take 2-5 minutes per video depending on length and queue load. The monitor will show progress updates every 30 seconds for long-running jobs.
