# Manual test checklist (v1)

Until we set up an integration test rig, run through this before tagging a
release. The whole loop should take ~10 minutes on a 5-minute test clip.

## Setup

- [ ] `git clean -fdx && npm ci && cargo build --manifest-path src-tauri/Cargo.toml`
- [ ] `./src-tauri/binaries/fetch.sh` reports all three binaries present
- [ ] `npm run tauri:dev` launches with no console errors

## Import + transcribe

- [ ] Drag a `.mp4` onto the window → metadata appears in the sidebar
- [ ] Filename, resolution, duration are correct vs. `ffprobe` on the CLI
- [ ] Click **Transcribe**, pick `large-v3-turbo`, accept download prompt
- [ ] Progress bar advances; final transcript appears
- [ ] Click any word → video seeks to that timestamp
- [ ] Words highlight as the video plays

## Edit

- [ ] Select two adjacent words → press Delete → words show as struck-through
- [ ] Hit Play → audio skips the deleted range cleanly (no audible artefact)
- [ ] Cmd+Z restores the deletion
- [ ] Repeat with a longer range crossing a paragraph boundary
- [ ] Select a leading word → delete → segment trims from the start
- [ ] Select a trailing word → delete → segment trims from the end

## Save / load

Phase 1 correction metadata is exercised by the shared synthetic fixture and
native round-trip tests (`tests/transcript.test.ts` and Rust `transcript::tests`).
Inline correction, restoration, and caption UI checks become applicable in the
later implementation phases; a legacy project should still open without being
marked dirty merely by loading it.

- [ ] Cmd+S → choose location → `.scribe` bundle appears on disk
- [ ] Quit and relaunch
- [ ] Recent files menu shows the project; opening it restores all edits
- [ ] File → Open Project selects a `.scribe` folder and restores saved edits
- [ ] Toolbar Open → select the bundle's `project.json`; it opens as a project
      without a media-import/FFprobe error; Save writes back to the bundle
- [ ] Drop the `.scribe` folder (or its `project.json`) onto the app; saved
      edits and transcripts are restored and old playback/pause state is cleared
- [ ] Toolbar Open still imports an ordinary MP4 as a new project
- [ ] Move the source media file; relaunch → relink dialog appears; selecting
      the new path completes successfully

## Export

- [ ] Cmd+E → choose output → progress bar advances
- [ ] Output `.mp4` plays in QuickTime
- [ ] Output duration matches `totalDuration(project)` (within ±100ms)
- [ ] No audio glitches at cut boundaries
- [ ] Cancel works: hitting Cancel mid-export terminates ffmpeg promptly

## Caption export

- [ ] Use a freshly rebuilt app (4.3.1 or newer), open a transcribed project,
      and click **Captions** beside **Export .mp4**
- [ ] Save an `.srt` file to a location chosen in the native save dialog;
      confirm success and numbered cues with comma-separated milliseconds
- [ ] Save a `.vtt` file; confirm success, a `WEBVTT` header, and timestamps
      with dot-separated milliseconds
- [ ] Check that technical terms, punctuation, and non-ASCII text are preserved
- [ ] Cancel the save dialog; confirm no file is created and no error appears
- [ ] Attempt an unavailable destination; confirm a failure is reported
- [ ] Confirm caption export leaves the transcript, timeline, and media unchanged

## Performance smoke check (M2 Pro)

- [ ] 5-minute clip transcribes in < 60s with `large-v3-turbo`
- [ ] 5-minute edit exports (re-encode-all) in < 30s
