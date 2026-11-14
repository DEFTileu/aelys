# Companion feature report

## Step 0
- Preserved all 40 previously uncommitted WIP paths as-is on `codex/companion-action-journal`, commit `29da495`; `git diff --check` identified an existing extra blank line at EOF, preserved as requested.
- Returned `codex/companion-character` to `f80d12d`. A merge of main (`a8417c3` at inspection) was attempted and aborted: the merged backend has two Alembic heads (`0055_companion_character` and `0056_telegram_task_suggestions`), requiring a server migration outside the requested scope. Main was not changed.
- Baseline `idf.py build`: PASS. `cmake -S sim -B sim/build && cmake --build sim/build -j 8 && ctest --test-dir sim/build --output-on-failure`: PASS, 54/54.

## Stages
- S2: partial, pre-existing character implementation at `f80d12d`; 32 mood codes plus always-level design state, reason-bearing priority chain, and home face at 130% of original design scale are present. Full design completeness not established; always-level is S3. No new feature commit.
- S3: not implemented.
- S4: not implemented.
- S5: not implemented.
- S6: not implemented.
- S7: not implemented.
- S8: not implemented.

## Screenshots
- `firmware/companion/docs/shots/s2-aelys.bmp`
- `firmware/companion/docs/shots/s2-sleep.bmp`

No feature was added behind a flag. No board, Wi-Fi, microphone, speaker, deployment, push, or main checkout was touched. Existing character branch may contain unrelated backend work predating this request; no server changes were added.
