# Changelog

User-facing changes to this fork of
[renjfk/opencode-voice](https://github.com/renjfk/opencode-voice).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project aims to follow [Semantic Versioning](https://semver.org/). A
release here is a tag plus GitHub release notes — the fork is installed from
source, not published to npm.

## Unreleased

Everything below has landed since upstream `v0.6.0`. This fork has not cut a
release of its own yet, so all of it is unreleased.

### Added

- **`/voice` settings hub** — one screen listing every runtime setting with its
  current value: input mode, auto-submit, text cleanup, transcription model,
  microphone, auto-gain, plus "Run setup again". Toggles flip in place; pickers
  open from it and return to it. The `/stt-*` commands are shortcuts to the same
  pickers.
- **First-run setup wizard** — names a missing `sox` with the install command
  for your platform, installs nemo-speech, downloads the transcription model,
  and picks the cleanup model and input mode. "Setup complete" now means ready
  to dictate.
- **Cleanup model auto-pick** — a `/models`-style picker with a _Test and
  auto-pick_ row that sends one small real cleanup request per model, a few at a
  time so the probes do not trip the rate limit they are measuring, then ranks
  by correction quality and latency. Models that failed stay listed with their
  reason instead of vanishing. Results are cached for five minutes and the title
  says how old they are.
- **Live transcription in the prompt bar** — the interim text covers all audio
  so far and is re-decided with more context on every refresh, so punctuation
  and earlier words self-correct while you keep talking. Text typed beforehand
  is stashed and restored. On release only the tail is re-transcribed, so there
  is no full re-transcription stall.
- **Background tasks with progress** — installs and model downloads run
  detached, several at a time, reporting one progress line each in a panel.
  Downloads show a real percentage measured from the cache, and a "Background
  tasks" row in `/voice` shows what is running and can cancel it.
- **Per-model download state** — the model picker marks each model as
  downloaded, part-downloaded (enter resumes), downloading, or not downloaded,
  and the hub says whether the active model is actually on disk.
- **Back navigation on every `/voice` sub-screen** — select the visible `← Back`
  row or press `Alt+Left`, while Escape still closes the menu entirely.
- **Auto-submit toggle** at runtime, off by default: dictation lands in the
  prompt for review unless you turn it on.
- `trimSilence` option to control sox silence trimming (Dror-Kaufman).
- `tmpDir` option for the temporary recording file (draxxris).
- Cross-platform audio backend detection and input-device selection
  (Crixus Xue).
- **Managed transcription runtimes** — Qwen3-ASR uses the official vLLM wrapper
  and Fun-ASR Nano uses the official llama.cpp/GGUF runtime. Fun-ASR MLT remains
  available through an externally managed WebSocket server.

### Changed

- **nemo-speech remains the default local transcription engine**, with optional
  managed Qwen3-ASR and Fun-ASR Nano runtimes plus external server backends.
- **Cleanup runs through the host OpenCode server by default** — your own
  models, including free Zen ones — instead of requiring an OpenAI-compatible
  endpoint configured up front. A pinned `endpoint` in `tui.json` still wins.
- **Live transcript defaults to the prompt bar.** Set
  `liveTranscriptTarget: "toast"` for the old floating notification. If the
  prompt cannot be updated, the live preview now stops with a clear error
  instead of silently moving dictation into the notification corner; final text
  still lands in the prompt on release.
- **Nothing downloads by itself.** The talk key refuses to record when the
  chosen model is not on disk and opens the download screen instead, rather than
  pulling ~700 MB inside the first transcription with the key wedged for its
  duration. Declining is now stated plainly: dictation stays unavailable until
  you download it.
- Tap mode stops listening without auto-submitting.
- Dialog rows are laid out against the real terminal width, so titles, values
  and metrics stay on one line instead of being clipped mid-word.

### Fixed

- Qwen3-ASR's `language ...<asr_text>` response wrapper could be inserted into
  the prompt as if it were dictated text; the OpenAI-compatible adapter now
  keeps only the transcript.
- Editing or deleting a previous dictation could leave the plugin's accumulated
  text tracker stale and resurrect that text on the next recording. Prompt edits
  now invalidate the tracker so the current prompt is preserved.
- Setup asked for a **second ~700 MB download** after the first one finished:
  the wizard's download screen and the gate in front of it read an unset model
  setting two different ways, so they disagreed about which model was wanted.
- **Testing cleanup models gave no sign it was running**, so pressing the button
  again — the natural thing to do during a round that takes tens of seconds —
  fired a whole second round of requests at the same models and stacked a second
  results screen. One round at a time now, behind a screen that counts answers
  as they land.
- "Is any model cached?" was asked where "is _this_ model cached?" was meant, so
  switching models reached the talk key with nothing downloaded and stalled
  inside a dictation.
- Cleanup probed the transport the host actually serves (`/v1` or session chat)
  rather than assuming one, and sends both session path-parameter spellings, so
  cleanup works across OpenCode builds and SDK generations.
- Auto-pick reported _why_ a probe failed, and stopped caching failures as
  authoritative "this model does not respond" answers for five minutes.
- A missing `sox` is named during setup with its install command on a screen
  that stays up, instead of failing at the first key press with a bare spawn
  error in a three-second toast.
- nemo-speech is resolved from `~/.local/bin`, so a fresh install works
  immediately instead of after a restart.
- Binaries are probed by PATH lookup rather than by running `--version`, which
  reported working installs as missing for tools that reject the flag.
- Clipboard writes are verified with system tools before OSC 52 is trusted.
- The tool exit listener is attached before stdin is written, closing a race
  that could drop a result.

### Removed

- whisper.cpp and remote transcription-API engines, along with the engine and
  model-size settings that existed only to choose between them.
- The runtime custom cleanup endpoint. Settings written by it are migrated away
  on load, since they named an endpoint nothing reads any more.

## v0.6.0 and earlier

Released by the upstream project; see its
[releases](https://github.com/renjfk/opencode-voice/releases).
