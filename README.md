[![CI](https://github.com/dwyercolin/opencode-voice/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dwyercolin/opencode-voice/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

# opencode-voice

Speech-to-text dictation plugin for [OpenCode](https://opencode.ai/).

Hold `ctrl+r`, talk, and a live transcription streams into your prompt. When you
release, an LLM cleanup pass fixes punctuation, filler words, and software
engineering homophones ("Jason" to "JSON", "bullion" to "boolean").

Transcription runs locally with NVIDIA's Parakeet/Nemotron models via
[NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp) — more accurate
than Whisper on English, immune to silence hallucination, and it punctuates
natively. The `/voice` setup wizard installs everything.

> [!NOTE]
> This is a fork of [renjfk/opencode-voice](https://github.com/renjfk/opencode-voice)
> by Soner Köksal. It is **not published to npm** — install from source (below).
> For the published, upstream-maintained package, use
> [`@renjfk/opencode-voice`](https://www.npmjs.com/package/@renjfk/opencode-voice).
>
> Developed and tested on Linux. **macOS is not yet tested** — the macOS code
> paths are upstream's and unchanged, and testing is planned.

## What is different in this fork

Repairs to the cleanup-model machinery, which assumed one specific shape of
OpenCode host server and broke on others.

- **The cleanup transport is detected, not assumed.** Builds differ in how they
  expose models: the OpenAI-compatible `/v1/chat/completions` endpoint, or the
  server's own chat routing (`session.prompt` in a throwaway session — what the
  TUI itself uses). Upstream picked one; on a host serving only the other, every
  cleanup model failed. The plugin now probes both once per process and uses
  whichever answered, preferring `/v1`.
- **Model discovery reads the TUI's own provider list** (`api.state.provider`,
  the same list `/models` renders) instead of relying only on HTTP config
  routes, which some builds answer with `404 Endpoint not supported`. SDK
  responses are also unwrapped correctly — the current generation returns a
  `{ data, error }` envelope and reports API errors as a _value_, so reading
  fields straight off the result silently yielded `undefined`.
- **Auto-pick reports failures instead of hiding them.** Models that failed stay
  on screen, greyed out, with the reason (`HTTP 429`, `HTTP 401`, …), and a
  screen where everything failed still offers a way forward. Probes are capped
  at 3 concurrent so the burst does not trip the rate limit it is measuring.
- **The runtime "custom endpoint" flow was removed** from the `/voice` menu. An
  existing `custom` setting is cleared on startup.
- **The debug log is opt-in.** It was previously always on, writing a trace that
  quotes your dictated text into a world-readable temp directory. It now
  requires `"debugLog": true`. A startup diagnostic that dumped host client
  internals to the same file was removed.

Everything else — recording, live transcription, the local nemo-speech pipeline,
voice modes, auto-gain — is upstream's work, unchanged.

## Install

Clone the repo and point OpenCode at the checkout:

```bash
git clone https://github.com/dwyercolin/opencode-voice.git
```

Add it to `~/.config/opencode/tui.json` (create the file if it doesn't exist),
using the **absolute path** to the clone:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "keybinds": {
    "session_rename": "none"
  },
  "plugin": ["/absolute/path/to/opencode-voice"]
}
```

There is no build step and no runtime dependencies — the plugin is plain ESM and
loads directly from the checkout, so `git pull` is the whole update process. To
pass [options](#options), use the array form:
`[["/absolute/path/to/opencode-voice", { "autoSubmit": true }]]`.

Then run `/voice` in OpenCode. The setup wizard installs nemo-speech if needed
(in the background — keep working, it notifies when done), points text cleanup at
the models you are already logged into OpenCode with, and asks how the talk key
should behave.

> [!NOTE]
> **Clobbering default keybinds.** This plugin uses `ctrl+r`, but OpenCode
> assigns it to session rename by default. Session rename is still available via
> `/rename`, so the config above clobbers the factory binding.

## Prerequisites

Recording needs `sox`; transcription needs
[nemo-speech](https://github.com/NVIDIA/NeMo-Speech.cpp), which `/voice`
installs for you, or manually:

```bash
curl -fsSL https://github.com/NVIDIA/NeMo-Speech.cpp/raw/main/scripts/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

No model download is needed: the first transcription pulls the pinned GGUF
(~700 MB, SHA-256-verified) into `~/.cache/nemo-speech/models`. Switch models
with `/stt-model` — Parakeet TDT leads the Open ASR leaderboard for English and
cannot hallucinate on silence; Nemotron covers other languages.

### Linux (including WSL2)

`sox` needs its PulseAudio driver (a separate package on Debian/Ubuntu) plus the
PulseAudio tools, so the plugin can enumerate input devices:

```bash
sudo apt install sox libsox-fmt-pulse pulseaudio-utils
```

Verify your microphone before anything else, otherwise `/stt-mic` will have
nothing to select:

```bash
sox -d /tmp/mic-check.wav trim 0 3   # speak for 3 seconds
play /tmp/mic-check.wav              # you should hear yourself
rm /tmp/mic-check.wav
```

At runtime the plugin records through sox's `pulseaudio` driver when `pactl` is
available, and falls back to sox's default device otherwise.

**WSL2.** Make sure [WSLg](https://learn.microsoft.com/windows/wsl/tutorials/gui-apps)
is running — it bridges the Windows microphone in as a PulseAudio source
(typically `RDPSource`), selectable with `/stt-mic`. There is no `/dev/snd` in
WSL2, which is normal: audio goes through WSLg's PulseAudio server at
`/mnt/wslg/PulseServer`, so ALSA-only tools like `arecord -l` will never list a
device. If `/stt-mic` finds nothing or `pactl info` fails with
`Connection refused`, WSLg's PulseAudio is stuck — run `wsl --shutdown` from
Windows PowerShell, then reopen your distro. If the list is still empty, enable
both "Microphone access" and "Let desktop apps access your microphone" in
Windows **Settings → Privacy & security → Microphone**, then `wsl --update`.

### macOS

Not yet tested in this fork; the steps below are upstream's.

```bash
brew install sox
```

The first `sox -d` triggers a microphone permission prompt — grant it in
**System Settings → Privacy & Security → Microphone**, then verify with the
`sox -d` / `play` check above.

## The cleanup LLM

Transcription is local. The **cleanup pass** — punctuation, filler words,
homophones — is a separate LLM call, and it is not local: it runs against the
OpenCode server you are already using, so your dictated text goes wherever that
server routes it.

There is nothing to configure. `/voice` points cleanup at the host OpenCode
server, reusing whatever models you are logged in with — your `small_model` is
preferred, since that is OpenCode's own setting for cheap auxiliary work. You
can also browse every available model `/models`-style from the same screen and
pick one for cleanup only; small models are shown first and the list starts
filtered to just those.

Set `sttNormalize: false` to skip cleanup entirely and keep raw dictation.

> [!NOTE]
> Upstream also supports pointing cleanup at an arbitrary OpenAI-compatible
> endpoint (including a local one) via plugin options. Those code paths are
> untested in this fork, so they are deliberately not documented here.

## Options

All optional; `/voice` configures the common ones at runtime.

**Voice input**

- `voiceKey` — keybind for voice input (default `ctrl+r`). Accepts OpenCode
  keybind strings, e.g. `"ctrl+r"`, `"f2"`, `"<leader>v"`
- `voiceMode` — default mode when `/voice` has not set one: `"hold"` (push to
  talk) or `"tap"` (tap to toggle) (default `hold`)
- `autoSubmit` — submit the prompt automatically when dictation finishes
  (default `false` — text lands in the prompt for review). Also toggleable from
  `/voice`

**Transcription and audio**

- `sttNemoModel` — default nemo-speech model short name (default: the CLI's own
  default, `nemotron-3.5`). For English, `parakeet-tdt` is faster and more
  accurate
- `autoGain` — measure each recording and boost quiet input (below ~-32 dB RMS)
  before transcription, up to +28 dB with a limiter (default `true`). Toggle
  with `/stt-gain`
- `trimSilence` — remove leading silence from recordings (default `true`). Set
  `false` if recordings are missing the first word or syllable
- `tmpDir` — directory for the temporary recording file (default `/tmp`)

**Live transcription**

- `liveTranscript` — show an interim transcription while recording (default
  `true`)
- `liveTranscriptTarget` — `"toast"` (default; floating, never touches your
  typing) or `"prompt"` (Claude Code-style; replaces the prompt text on each
  refresh, with a brief flicker)
- `liveTranscriptIntervalMs` — refresh interval (default `1200`, minimum `600`)

**Cleanup**

- `sttNormalize` — set `false` to disable the cleanup pass entirely (default
  `true`). When enabled, cleanup is skipped automatically for transcriptions
  that already look clean, so well-formed dictation finalizes without an LLM
  round trip
- `normalizeTimeoutMs` — how long to wait for cleanup before falling back to the
  raw transcription (default `10000`)

**Diagnostics**

- `debugLog` — set `true` to trace the dictation pipeline to
  `opencode-voice-debug.log` in your temp directory (default `false`). The trace
  quotes transcribed text and the temp directory is world-readable on most
  systems, so enable it only while diagnosing an issue

Routine diagnostics also go to OpenCode's structured app logger (`debug` for
routine, `warn` for recoverable, `error` for failed child processes and API
calls). See the [OpenCode docs](https://opencode.ai/docs/troubleshooting/#logs).

## Commands

| Command       | Keybind  | Description                                   |
| ------------- | -------- | --------------------------------------------- |
| `/voice`      |          | Setup wizard, then the voice settings hub     |
| `/stt-record` | `ctrl+r` | Record via active voice mode, then transcribe |
| `/stt-submit` |          | Stop recording, transcribe, and submit        |
| `/stt-stop`   |          | Cancel recording                              |
| `/stt-model`  |          | Select nemo-speech model                      |
| `/stt-gain`   |          | Toggle auto-gain                              |
| `/stt-mic`    |          | Select microphone                             |

### The `/voice` menu

On first run `/voice` is a short wizard: install nemo-speech if missing, pick the
cleanup model, pick how the talk key behaves. After that it opens a settings
screen showing every runtime setting with its current value — input mode,
auto-submit, text cleanup, transcription model, microphone, auto-gain — plus a
"Run setup again" row. Toggles flip in place; pickers return to the screen. The
`/stt-*` commands are shortcuts to the same pickers.

Two ways to choose a cleanup model:

- **Test and auto-pick** sends a tiny real cleanup request to each small model (a
  few at a time, so the probes do not trip the rate limit they are measuring) and
  ranks the ones that answered by correction quality then speed. Models that
  failed stay listed below, greyed out, with the reason. Successful results are
  cached for five minutes — the title says how old they are, and **Test again**
  re-checks the connection and re-probes everything.
- **Browse all models** is a `/models`-style picker fed by merged sources (the
  TUI's provider list, `/config/providers` where it exists, the host server's
  `/v1/models`, and the models.dev catalog for providers those lists named). It
  shows only small models by default, with a "Show all models" row at the bottom.

## Voice input modes

- **Push to talk** — hold `ctrl+r` (or your `voiceKey`): a brief warmup shows
  "keep holding", then recording starts. Release to stop and transcribe. A quick
  single tap is a no-op with a hint toast.
- **Tap to toggle** — tap `ctrl+r` to start, tap again to stop and transcribe.

Either way the text lands in the prompt for review; whether it is then sent is
the separate **auto-submit** setting. Push-to-talk detection watches key-repeat
events, so it needs a terminal that emits auto-repeat while a key is held
(virtually all do; if yours does not, use tap mode). The mode persists across
sessions via `api.kv`.

## Live transcription

While recording, the plugin snapshots the in-progress audio roughly every 1.2s
(the first pass fires almost immediately) and transcribes _all_ audio so far, so
the interim text keeps improving: earlier words are re-decided with more context,
and punctuation self-corrects as you keep talking.

Dictations accumulate. The prompt is rebuilt as
`[typed text][previous dictations][live text]`, so dictating again appends to
what was already spoken, and the accumulation resets when the prompt is
submitted. Text typed before dictating is protected via the TUI's `prompt.stash`
and restored when dictation finishes.

> One known quirk: if you type after a dictation finalizes and then dictate
> again, the previous dictation can appear twice (the stashed state and the
> plugin's own tracking overlap) — delete the duplicate before submitting. Avoid
> typing while actually recording; refreshes rewrite the prompt every tick.

On release there is no full re-transcription stall: only the audio since the last
refresh (plus a 1s overlap, deduplicated word-wise) is transcribed, merged with
the interim text, and the cleanup pass swaps in the final result — typically 1-2s
with the prompt showing your text the whole time. Set `liveTranscript: false` to
turn it off.

## Auto-gain

If the model can barely hear you, auto-gain (on by default) measures every
recording and live partial; below ~-32 dB RMS the audio is boosted toward -18 dB
with a lookahead limiter before transcription. No system settings are touched,
and loud input is left alone. Toggle with `/stt-gain`; adjust your actual mic
level in your OS mixer.

## How it works

1. `sox` records from your microphone (PulseAudio on Linux when `pactl` is
   available, CoreAudio on macOS, sox's default device otherwise)
2. `nemo-speech` transcribes locally
3. An LLM normalizes the transcript: punctuation, filler words, and software
   engineering homophones
4. The cleaned text is appended to the OpenCode prompt, or submitted immediately
   when auto-submit is on. If cleanup fails (unreachable, rate limited, or slow),
   the raw transcription is used so you never lose your input

`/stt-mic` lists PulseAudio sources on Linux (via `pactl`, monitors excluded) and
CoreAudio devices on macOS. Without a supported device listing, "System default"
uses `sox -d`.

## Development

No build step — plain ESM JavaScript, shipped as-is.

```bash
npm install          # dev tooling only (oxlint, oxfmt)
npm test             # node --test
npm run check        # lint + fmt
npm run fmt:fix      # oxfmt --write
```

OpenCode loads the plugin straight from the checkout, so edits take effect on the
next TUI restart — nothing to publish or reinstall. See [AGENTS.md](AGENTS.md)
for the architectural invariants worth knowing before changing anything.

Commit format is `type: brief description`, with `feat:`, `fix:`, `enhance:`,
`chore:`, `docs:`, and `build:`.

### Optional macOS Hammerspoon integration

`/voice` push-to-talk already covers this flow inside the terminal. For a
**global** key that works outside the terminal window on macOS with
[Hammerspoon](https://www.hammerspoon.org/) and [Ghostty](https://ghostty.org/),
see [`examples/hammerspoon/ghostty-fn.lua`](examples/hammerspoon/ghostty-fn.lua):
hold `Fn` to hold `ctrl+r`, and the prompt finalizes on release. Adjust
`APP_NAME` and `TARGET_TERMINAL` to fit your setup. Untested in this fork.

## Credits

Original plugin by [Soner Köksal](https://github.com/renjfk) —
[renjfk/opencode-voice](https://github.com/renjfk/opencode-voice). Bug reports
about behavior that also exists upstream are best filed there; this fork tracks
it loosely.

## License

MIT — see [LICENSE](LICENSE). Copyright is held jointly by the original author
and this fork's contributors.
