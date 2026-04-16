"""Patch lib/assembly.js: insert OUTRO tpad freeze-hold block before line 1977."""

TPAD_BLOCK = """\
        // \u2500\u2500 Gap #45: OUTRO freeze-hold \u2014 clone last frame for 0.75s (long-form only) \u2500\u2500
        if (!isShortForm && label && label.toUpperCase().includes('OUTRO')) {
          try {
            const heldPath = path.join(TMP_DIR, `${asmId}_outro_held_${i}.mp4`);
            await new Promise((res, rej) => {
              const args = [
                '-i', inputForTS,
                '-vf', 'tpad=stop_mode=clone:stop_duration=0.75',
                ...ffmpegEncodeArgs(true),
                '-c:a', 'aac', '-ar', '44100', '-ac', '2',
                '-y', heldPath
              ];
              const proc = execFile(ffmpegPath(), args, { maxBuffer: 50 * 1024 * 1024 });
              proc.on('close', code => code === 0 ? res() : rej(new Error(`tpad freeze-hold failed: ${code}`)));
              proc.on('error', rej);
            });
            if (fs.existsSync(heldPath) && fs.statSync(heldPath).size > 10000) {
              inputForTS = heldPath;
              log(asmId, `  \ud83d\udd12 OUTRO freeze-hold applied (+0.75s): ${label}`);
            }
          } catch(e) {
            log(asmId, `  \u26a0\ufe0f  OUTRO freeze-hold failed (non-fatal): ${e.message} \u2014 using original`);
          }
        }

"""

with open('lib/assembly.js', 'r') as f:
    lines = f.readlines()

# Find the target line (0-indexed = 1976 for line 1977)
target_idx = None
for i, line in enumerate(lines):
    if 'const tsPath = inputForTS.replace' in line and "'.ts'" in line:
        target_idx = i
        print(f'Found target at line {i+1}: {repr(line[:80])}')
        break

if target_idx is None:
    print('ERROR: target line not found')
    exit(1)

new_lines = lines[:target_idx] + [TPAD_BLOCK] + lines[target_idx:]

with open('lib/assembly.js', 'w') as f:
    f.writelines(new_lines)

print(f'Done. File now has {len(new_lines)} lines. Inserted before line {target_idx+1}.')

with open('lib/assembly.js', 'r') as f:
    content = f.read()

if 'tpad=stop_mode=clone:stop_duration=0.75' in content:
    print('VERIFIED: tpad filter present in file')
else:
    print('ERROR: tpad not found after insert')
    exit(1)