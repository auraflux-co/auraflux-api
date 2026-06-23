#!/bin/bash

LOG_FILE="/Users/robertgregory/cwn-production/logs/gemini_watch_summary.jsonl"
DURATION_SECONDS=7200 # 2 hours
INTERVAL_SECONDS=90
ITERATIONS=$((DURATION_SECONDS / INTERVAL_SECONDS))

echo "Starting Gemini Vision Report Monitoring for 'MAIN' stream..."
echo "Monitoring for $DURATION_SECONDS seconds ($ITERATIONS iterations) every $INTERVAL_SECONDS seconds."
echo "Log file: $LOG_FILE"
echo "----------------------------------------------------"

for (( i=1; i<=ITERATIONS; i++ ))
do
    echo "Iteration $i of $ITERATIONS (next check in $INTERVAL_SECONDS seconds)..."
    if [ ! -f "$LOG_FILE" ]; then
        echo "Error: Log file not found at $LOG_FILE. Skipping this iteration."
        sleep $INTERVAL_SECONDS
        continue
    fi

    LATEST_ENTRY=$(tail -n 100 "$LOG_FILE" | tac | jq -s -c 'map(select(.label == "MAIN")) | .[0]' 2>/dev/null)

    if [ -z "$LATEST_ENTRY" ]; then
        echo "No 'MAIN' entry found in the last 100 lines of the log file."
    else
        SEVERITY=$(echo "$LATEST_ENTRY" | jq -r '.severity' 2>/dev/null)
        CONTENT_SUMMARY=$(echo "$LATEST_ENTRY" | jq -r '.contentSummary' 2>/dev/null)
        QUALITY_ISSUES=$(echo "$LATEST_ENTRY" | jq -r '.qualityIssues // "none"' 2>/dev/null) # Use // "none" for null or missing

        STATUS_LINE="Severity: $SEVERITY, Summary: '$CONTENT_SUMMARY', Quality Issues: '$QUALITY_ISSUES'"
        echo "$STATUS_LINE"

        if [[ "$SEVERITY" == "critical" || "$QUALITY_ISSUES" == *"encoder not running"* ]]; then
            echo "****************************************************"
            echo "!!! ALERT: CRITICAL ISSUE DETECTED for MAIN stream !!!"
            echo "$STATUS_LINE"
            echo "****************************************************"
        fi
    fi
    echo "----------------------------------------------------"
    sleep $INTERVAL_SECONDS
done

echo "Monitoring complete."
