[![CI](https://github.com/dwyercolin/opencode-voice/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dwyercolin/opencode-voice/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@renjfk/opencode-voice)](https://www.npmjs.com/package/@renjfk/opencode-voice)
[![Downloads](https://img.shields.io/npm/dm/@renjfk/opencode-voice)](https://www.npmjs.com/package/@renjfk/opencode-voice)

# opencode-voice

Speech-to-text dictation plugin for [OpenCode](https://opencode.ai/).

Hold `ctrl+r`, talk, and a live transcription streams into your prompt. When
you release, an LLM cleanup pass fixes punctuation, filler words, and software
engineering homophones ("Jason" to "JSON", "bullion" to "boolean").

Transcription runs locally with NVIDIA's Parakeet/Nemotron models via
[NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp) - more accurate
than Whisper on English, structurally immune to silence hallucination, and it
punctuates natively. The `/voice` setup wizard installs everything.

Voice input works like Claude Code's `/voice`: **push to talk** — hold `ctrl+r`
and speak, with an animated "Listening..." indicator up and a live
transcription appearing in the prompt — or **tap to toggle**, tapping once to
start and again to stop.

## Install

Add to your `tui.json` (create at `~/.config/opencode/tui.json` if it doesn't
exist). After installing, run `/voice` in OpenCode: the setup wizard installs
nemo-speech in the background if needed (with a loading bar — keep working, it
notifies when done), points text cleanup at the models you're already logged
into OpenCode with (including free opencode Zen models), and asks how the talk
key should behave:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "keybinds": {
    "session_rename": "none"
  },
  "plugin": [["@renjfk/opencode-voice"]]
}
```

To configure the cleanup LLM explicitly instead, pass `endpoint`/`model`
(any OpenAI-compatible endpoint):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "keybinds": {
    "session_rename": "none"
  },
  "plugin": [
    [
      "@renjfk/opencode-voice",
      {
        "endpoint": "https://api.anthropic.com/v1",
        "model": "claude-haiku-4-5",
        "apiKeyEnv": "ANTHROPIC_API_KEY"
      }
    ]
  ]
}
```

> [!NOTE]
> **Clobbering default keybinds.** This plugin uses `ctrl+r` for voice
> recording, but OpenCode assigns it to session rename by default. Session
> rename is not used frequently and is still accessible via `/rename`, so we
> clobber the factory default to let the plugin use `ctrl+r` properly. See
> the `keybinds` section in the config above.

### Refresh cached plugin after updates

If OpenCode keeps using an older published version of the plugin after an
update, clear the cached package and restart OpenCode:

```bash
rm -rf ~/.cache/opencode/packages/@renjfk/
```

## Prerequisites

### Speech-to-text

Recording needs `sox`; transcription runs locally with
[nemo-speech](https://github.com/NVIDIA/NeMo-Speech.cpp) (NVIDIA Parakeet /
Nemotron models). The `/voice` setup wizard installs nemo-speech for you in
the background - keep working, it notifies when done - or install manually:

```bash
curl -fsSL https://github.com/NVIDIA/NeMo-Speech.cpp/raw/main/scripts/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

No manual model download is needed: the first transcription pulls the pinned
GGUF (~700 MB, SHA-256-verified) into `~/.cache/nemo-speech/models`. Pick a
specific model with `/stt-model` (Parakeet TDT leads the Open ASR leaderboard
for English and cannot hallucinate on silence; Nemotron covers other
languages).

#### macOS

```bash
brew install sox
```

Verify your microphone by recording a 3-second clip and playing it back. The
first `sox -d` invocation triggers a macOS microphone permission prompt —
grant it in **System Settings → Privacy & Security → Microphone**, then rerun:

```bash
sox -d /tmp/mic-check.wav trim 0 3   # speak for 3 seconds
play /tmp/mic-check.wav              # you should hear yourself
rm /tmp/mic-check.wav                # delete after verification
```

Smoke-test transcription:

```bash
sox -d /tmp/smoke.wav trim 0 4   # say something for 4 seconds
nemo-speech transcribe /tmp/smoke.wav
rm /tmp/smoke.wav
```

#### Linux (including WSL2)

Install `sox` with its PulseAudio driver (a separate package on Debian/Ubuntu)
plus the PulseAudio tools so the plugin can enumerate input devices:

```bash
sudo apt install sox libsox-fmt-pulse pulseaudio-utils
```

On WSL2, make sure [WSLg](https://learn.microsoft.com/windows/wsl/tutorials/gui-apps)
is running — it bridges the Windows microphone into WSL as a PulseAudio source
(typically named `RDPSource`), which you can then pick with `/stt-mic`.

**WSL2 audio troubleshooting.** There is no `/dev/snd` in WSL2 — that is
normal. Audio goes through WSLg's PulseAudio server at `/mnt/wslg/PulseServer`,
so ALSA-only tools like `arecord -l` will never list a device. If `/stt-mic`
finds no devices or `pactl info` fails with `Connection refused`, WSLg's
PulseAudio is stuck; fix it from Windows PowerShell:

```powershell
wsl --shutdown   # then reopen Ubuntu (closes all WSL sessions)
```

If the source list is still empty after a restart, check Windows
**Settings → Privacy & security → Microphone** and enable both "Microphone
access" and "Let desktop apps access your microphone" (WSLg captures audio via
a desktop RDP client), then run `wsl --update` for the latest WSLg.

Verify your microphone before anything else, otherwise `/stt-mic` will have
nothing to select:

```bash
sox -d /tmp/mic-check.wav trim 0 3   # speak for 3 seconds
play /tmp/mic-check.wav              # you should hear yourself
rm /tmp/mic-check.wav                # delete after verification
```

At runtime the plugin records through sox's `pulseaudio` driver when `pactl`
is available, and falls back to sox's default device otherwise.

### LLM endpoint

The post-dictation cleanup pass (punctuation, filler words, software
engineering homophones) needs an LLM, but nothing to configure: when no
`endpoint` is set, `/voice setup` can point cleanup at the opencode server
you're already running, reusing whatever models you're logged in with -
including free opencode Zen models (your `small_model` is preferred, since
it's OpenCode's own setting for cheap auxiliary work). You can also browse
every authed model `/models`-style from the same screen and pick any of them
for cleanup only; small ones are shown first and the list starts filtered to
just those. An explicit
`endpoint`/`model` in `tui.json` always takes precedence; any
OpenAI-compatible endpoint works.

Configure your endpoint in `tui.json` via plugin options. Any OpenAI-compatible
endpoint works (Anthropic, OpenAI, Ollama, vLLM, LM Studio, etc.). The `apiKeyEnv`
option is optional - omit it for unauthenticated endpoints like Ollama.

```json
{
  "plugin": [
    [
      "@renjfk/opencode-voice",
      {
        "endpoint": "https://api.anthropic.com/v1",
        "model": "claude-haiku-4-5",
        "apiKeyEnv": "ANTHROPIC_API_KEY"
      }
    ]
  ]
}
```

For unauthenticated local endpoints (e.g. Ollama):

```json
{
  "plugin": [
    [
      "@renjfk/opencode-voice",
      {
        "endpoint": "http://localhost:11434/v1",
        "model": "llama3.2"
      }
    ]
  ]
}
```

- `endpoint` _(required)_ - OpenAI-compatible base URL
- `model` _(required)_ - model name sent to `/chat/completions`
- `apiKeyEnv` _(optional)_ - environment variable containing the API key
- `maxTokens` _(optional)_ - maximum completion tokens for normalization calls
- `reasoningEffort` _(optional)_ - reasoning level for models that support it
- `chatTemplateKwargs` _(optional)_ - extra keyword arguments passed to the model's chat template (e.g. `{"enable_thinking": false}` for Qwen models to disable chain-of-thought)
- `retries` _(optional)_ - number of retry attempts for transient LLM failures
- `tmpDir` _(optional)_ - directory used for the temporary STT recording file (default `/tmp`)
- `trimSilence` _(optional)_ - whether to remove leading silence from recordings (default `true`). Set to `false` if your recordings are missing the first word or syllable
- `voiceKey` _(optional)_ - keybind used for voice input (default `ctrl+r`). Accepts OpenCode keybind strings, e.g. `"ctrl+r"`, `"f2"`, or `"<leader>v"`
- `voiceMode` _(optional)_ - default voice input mode when `/voice` has not set one at runtime: `"hold"` (push to talk) or `"tap"` (tap to toggle) (default `hold`)
- `autoSubmit` _(optional)_ - submit the prompt automatically when dictation finishes, in push-to-talk mode on key release and in tap mode on the second press (default `false` - text lands in the prompt for review). Also toggleable at runtime from `/voice`
- `liveTranscript` _(optional)_ - show an interim transcription while recording (default `true`; local engines only)
- `liveTranscriptTarget` _(optional)_ - where interim text appears: `"prompt"` (replaces the prompt text on each refresh, Claude Code-style — text you typed before dictating is stashed and restored afterwards; each refresh briefly flickers) or `"toast"` (default; floating, never touches your typing)
- `liveTranscriptIntervalMs` _(optional)_ - how often the interim transcription refreshes (default `1200`, minimum `600`). Each refresh transcribes ALL audio so far, so the interim text self-corrects as more context arrives; the first words appear almost immediately after recording starts. On release only the audio since the last refresh is transcribed (plus a 1s overlap), then the LLM cleanup pass swaps in — no full re-transcription stall
- `normalizeTimeoutMs` _(optional)_ - how long to wait for the post-release LLM cleanup before falling back to the raw transcription (default `10000`). Prior prompt text stays stashed until the final swap, so keep this low if your normalization endpoint is slow
- `sttNormalize` _(optional)_ - set `false` to disable the LLM cleanup pass entirely (default `true`). When enabled, cleanup is skipped automatically for transcriptions that already look clean (punctuated, no filler words, no likely STT homophones like "locks"/"bullion"), so well-formed dictation finalizes instantly without an LLM round trip
- `autoGain` _(optional)_ - measure each recording and boost quiet input (below ~-32 dB RMS) before transcription, up to +28 dB with a limiter (default `true`). Toggle at runtime with `/stt-gain`
- `sttNemoModel` _(optional)_ - default nemo-speech model short name (default: the CLI's own default, `nemotron-3.5`). For English dictation, `parakeet-tdt` is faster and more accurate
- `debugLog` _(optional)_ - set `true` to trace the dictation pipeline to `opencode-voice-debug.log` in your temp directory (default `false`). The trace quotes transcribed text and the temp directory is world-readable on most systems, so turn it on only while diagnosing an issue

### Logging

The plugin writes diagnostics through OpenCode's structured app logger. If this plugin is not working with your setup, check the OpenCode log file and, optionally, enable debug mode. See the [OpenCode Docs](https://opencode.ai/docs/troubleshooting/#logs) for details.

Routine plugin diagnostics use `debug`; recoverable issues use `warn`; failed
child processes, API calls, or unexpected exceptions use `error`.

### Fully local / offline cleanup

The LLM cleanup pass works with any OpenAI-compatible endpoint, including
local servers, so the whole plugin can run offline (transcription already is
local via nemo-speech). With [LM Studio](https://lmstudio.ai)
for example:

```bash
lms get gemma-3-4b-it        # ~2.5 GB download
lms load gemma-3-4b-it
lms server start             # serves OpenAI API on http://127.0.0.1:1234/v1
```

```json
["opencode-voice", { "endpoint": "http://127.0.0.1:1234/v1", "model": "gemma-3-4b-it" }]
```

Benchmarked on this task (homophone fixes + filler removal + punctuation):

| Model                    | Size   | Avg latency | Correction quality            |
| ------------------------ | ------ | ----------- | ----------------------------- |
| gemma-3-4b-it (Q4)       | 2.5 GB | **0.26s**   | perfect on all test cases     |
| gpt-oss-20b (Q4, CPU)    | 11 GB  | 8.0s        | excellent, but heavy          |
| qwen3-1.7b (thinking)    | 1.6 GB | 3.9s        | misses half the corrections   |
| qwen3-1.7b (`/no_think`) | 1.6 GB | 0.13s       | near-verbatim output, useless |

gemma-3-4b-it is the recommendation: small enough for most machines
(~3 GB RAM at 4k context), 4-10x faster than cloud round trips, and fully
offline. Ollama works the same way (`endpoint: "http://127.0.0.1:11434/v1"`).
For Qwen-based models, set `"chatTemplateKwargs": {"enable_thinking": false}`
— and note smaller Qwens (≤1.7B) are too weak for the homophone corrections
even with thinking enabled.

## Commands

### Speech-to-text

| Command       | Keybind  | Description                                   |
| ------------- | -------- | --------------------------------------------- |
| `/voice`      |          | Setup wizard, then the voice settings hub     |
| `/stt-record` | `ctrl+r` | Record via active voice mode, then transcribe |
| `/stt-submit` |          | Stop recording, transcribe, and submit        |
| `/stt-stop`   |          | Cancel recording                              |
| `/stt-model`  |          | Select nemo-speech model                      |
| `/stt-gain`   |          | Toggle auto-gain                              |
| `/stt-mic`    |          | Select microphone                             |

#### The `/voice` menu

On first run `/voice` is a short wizard: it installs nemo-speech if it is
missing (in the background, with a progress bar in toasts), asks which model
should clean up your dictation, and asks how the talk key should behave. The
cleanup step recommends your opencode `small_model`. **Test and auto-pick**
probes your small models with a tiny real cleanup request (a few at a time, so
the probes don't trip the rate limit they're measuring) and offers the ones
that answered, ranked by correction quality then speed — best match on top.
Models that failed stay listed below them, greyed out, with the reason
(`HTTP 429`, `HTTP 401`, and so on) rather than silently disappearing.
Successful results are cached for five minutes, so reopening the picker reuses
them instead of spending another round of requests; the title says how old the
numbers are ("just tested", "tested 2m ago") and a **Test again** row
re-checks the connection and re-probes every model on demand. **Browse all
models** opens a `/models`-style picker — used only for cleaning dictation —
fed by merged sources (the TUI's own provider list, the server's
`/config/providers` where it exists, the host server's `/v1/models`, and the
models.dev catalog for providers those lists named), showing **only small
models** by default (fast + cheap; free models count as small), with a "Show
all models" row at the bottom when the heuristic misses something you want.

After that, `/voice` opens a settings screen showing every runtime setting
with its current value — input mode, auto-submit, text cleanup, transcription
model, microphone, auto-gain — plus a "Run setup again" row. Toggles flip in
place; pickers return to the screen. The `/stt-*` commands below are shortcuts
to the same pickers.

> **How cleanup reaches your models.** There are two ways into the host
> opencode server, and builds differ in which they serve: the
> OpenAI-compatible `/v1/chat/completions` endpoint, and the server's own chat
> routing (`session.prompt`, in a throwaway session — the transport the TUI
> itself uses). The plugin detects which exist once per process and uses
> whichever answered, preferring `/v1`. A per-model failure is reported
> against that model, not treated as the whole transport being dead.

#### Voice input modes

Mirrors Claude Code's voice dictation:

- **Push to talk** — hold `ctrl+r` (or your `voiceKey`): a brief warmup shows
  "keep holding", then recording starts. Release to stop and transcribe.
  A quick single tap is a no-op with a hint toast.
- **Tap to toggle** — tap `ctrl+r` to start recording, tap again to stop and
  transcribe.

Either way the text lands in the prompt for review; whether it is then sent is
the separate **auto-submit** setting (off by default, toggleable from `/voice`
or seeded with `"autoSubmit": true`).

Push-to-talk detection works by watching key-repeat events, so it needs a
terminal that emits auto-repeat while a key is held (virtually all do; if yours
does not, use tap mode). The mode persists across sessions via `api.kv`.

#### Auto-gain (`/stt-gain`)

If the model can barely hear you, auto-gain (default on) has you covered:
every recording (and each live partial) is measured; when the level is below
~-32 dB RMS, the audio is boosted toward -18 dB with a lookahead limiter
before transcription. No system settings are touched, and loud input is left
alone. Toggle it with `/stt-gain`; adjust your actual mic level with your OS
mixer.

#### Live transcription

While recording, the plugin snapshots the in-progress audio roughly every
1.2s (the first pass fires almost immediately), transcribes ALL audio so far
with the active engine, and shows the interim text — replacing the prompt text
(`liveTranscriptTarget: "prompt"`, Claude Code-style; a brief flicker on each
refresh) or as a floating toast (default). Because every pass covers the full
recording, the interim text keeps improving: earlier words are re-decided with
more context, so punctuation and mistakes self-correct as you keep talking.

Dictations accumulate: the prompt is rebuilt as `[typed text][previous
dictations][live text]`, so dictating again appends to what was already
spoken. The plugin tracks the dictation text it has appended (opencode's
prompt state only syncs what you type, so the TUI's own stash cannot preserve
appended text) and resets the accumulation whenever the prompt is submitted.
Text typed before dictating is protected via the TUI's `prompt.stash` and
restored when dictation finishes. One known quirk: if you type after a
dictation finalizes and then dictate again, the previous dictation can appear
twice (the stashed state and the plugin's own tracking overlap) — just delete
the duplicate before submitting. Avoid typing while actually recording;
refreshes rewrite the prompt every tick.

When you release, there is no full re-transcription stall: only the audio
since the last refresh (plus a 1s overlap, deduplicated word-wise) is
transcribed, merged with the interim text, and the LLM cleanup pass (punctuation,
homophones) swaps in the final result — typically 1-2s with the prompt
showing your text the whole time. Each refresh is a fresh one-shot pass over
the audio so far, so it works with every local engine (including offline-only
models like Parakeet TDT). Set `liveTranscript: false` to turn it off entirely.

`/stt-mic` lists CoreAudio input devices on macOS, and PulseAudio sources on
Linux (via `pactl`, monitor sources excluded). On systems without a supported
device listing, "System default" uses sox's default device (`sox -d`).

## How it works

### STT pipeline

1. `sox` records audio from your microphone (CoreAudio on macOS, PulseAudio on
   Linux when `pactl` is available, sox default device otherwise)
2. `nemo-speech` transcribes locally (Parakeet/Nemotron models)
3. LLM normalizes the transcription: fixes punctuation, removes filler words,
   corrects software engineering homophones ("Jason" to "JSON", "bullion" to
   "boolean", etc.)
4. Cleaned text is appended to the OpenCode prompt, or submitted immediately
   when auto-submit is on. If cleanup fails (e.g. LLM
   endpoint unreachable or slow), the raw transcription is used so you never
   lose your input

## Contributing

opencode-voice is open to contributions and ideas!

### Issue conventions

**Format:** `type: brief description`

- `feat:` new features or functionality
- `fix:` bug fixes
- `enhance:` improvements to existing features
- `chore:` maintenance tasks, dependencies, cleanup
- `docs:` documentation updates
- `build:` build system, CI/CD changes

### Development

```bash
npm run check        # lint + fmt
npm run lint         # oxlint
npm run fmt          # oxfmt --check
npm run fmt:fix      # oxfmt --write
```

### Test local plugin in OpenCode

To test unpublished changes in the OpenCode TUI, point `~/.config/opencode/tui.json`
at the local repo path, not the npm package name:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/Users/your-user/opencode-voice"]
}
```

### Optional macOS Hammerspoon integration

With `/voice` push-to-talk mode the built-in `ctrl+r` covers this flow,
but if you want a **global** key that works outside the terminal window and
you use macOS, [Hammerspoon](https://www.hammerspoon.org/), and
[Ghostty](https://ghostty.org/), see
[`examples/hammerspoon/ghostty-fn.lua`](examples/hammerspoon/ghostty-fn.lua)
for an optional global `Fn` key setup.

Behavior: hold `Fn` to hold `ctrl+r` - record while held, and the prompt
finalizes on release (add `"autoSubmit": true` to the plugin options to also
send it). Adjust `APP_NAME` and `TARGET_TERMINAL` to fit your setup.

### Release process

Manual releases via opencode; see [RELEASE_PROCESS.md](RELEASE_PROCESS.md).

## License

This project is licensed under the [MIT License](LICENSE).
