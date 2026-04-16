// Gap #45: OUTRO freeze-hold -- clone last frame for 0.75s (long-form only)
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
              log(asmId, `  [OUTRO] freeze-hold applied (+0.75s): ${label}`);
            }
          } catch(e) {
            log(asmId, `  [WARN] OUTRO freeze-hold failed (non-fatal): ${e.message} -- using original`);
          }
        }