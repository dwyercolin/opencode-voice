[![CI](https://github.com/dwyercolin/opencode-voice/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dwyercolin/opencode-voice/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

# opencode-voice

Speech-to-text dictation plugin for [OpenCode](https://opencode.ai/).

Hold `ctrl+r`, talk, and a live transcription streams into your prompt. When you
release, an LLM cleanup pass fixes punctuation, filler words, and software
engineering homophones ("Jason" to "JSON", "bullion" to "boolean").

Transcription uses the selected local model. The default is NVIDIA's
Parakeet/Nemotron models via [NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp).
The `/voice` setup wizard installs each selected runtime and model automatically.

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
  on screen with the reason (`HTTP 429`, `HTTP 401`, …), and a screen where
  everything failed still offers a way forward. Probes are capped
  at 3 concurrent so the burst does not trip the rate limit it is measuring.
- **The runtime "custom endpoint" flow was removed** from the `/voice` menu. An
  existing `custom` setting is cleared on startup.
- **The debug log is opt-in.** It was previously always on, writing a trace that
  quotes your dictated text into a world-readable temp directory. It now
  requires `"debugLog": true`. A startup diagnostic that dumped host client
  internals to the same file was removed.

Everything else — recording, live transcription, the NeMo compatibility path,
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

Then run `/voice` in OpenCode. The setup wizard selects a supported transcription
language, voice key, input mode, and model. It then installs the selected model if
needed, points text cleanup at the models you are already logged into OpenCode
with, and finishes with an instruction for using the key. Use `/stt-model` to
choose another local model or a remote model served through an OpenAI-compatible
audio endpoint.

> [!NOTE]
> **Clobbering default keybinds.** This plugin uses `ctrl+r`, but OpenCode
> assigns it to session rename by default. Session rename is still available via
> `/rename`, so the config above clobbers the factory binding.

## Prerequisites

Recording needs `sox`. The default local transcription backend needs
[nemo-speech](https://github.com/NVIDIA/NeMo-Speech.cpp), which `/voice` installs
for you, or manually:

```bash
curl -fsSL https://github.com/NVIDIA/NeMo-Speech.cpp/raw/main/scripts/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

The model is a separate download: `/voice` offers to pull the pinned GGUF
(~700 MB, SHA-256-verified) into `~/.cache/nemo-speech/models` in the background
during setup, and you can keep working while it lands. Nothing ever downloads on
its own — if you decline, dictation stays unavailable and the talk key opens the
same download screen instead of recording, so a ~700 MB pull is never something
a key press starts by surprise. Once the model is cached, transcription is
instant. The language picker is intentionally limited to Automatic, English,
Spanish, Chinese, Japanese, and Korean, which have explicit support in the
shipped model cards.

### Local Qwen3-ASR and Fun-ASR

Choose a model in `/voice` and the plugin installs its runtime and weights under
`~/.cache/opencode-voice/stt`, showing setup/download progress until it is ready.
No STT server URL or API key is required. The plugin package itself does not
bundle Python, CUDA libraries, or model weights.

Qwen3-ASR uses the official `qwen-asr-serve` vLLM wrapper and requires Linux,
`python3` with its `venv` module, `curl`, `setsid`, `flock`, an NVIDIA GPU, and a
working CUDA driver. On Debian/Ubuntu, the installer also bootstraps missing
Python development headers into its cache for Triton. Qwen reserves 60% of GPU
memory and sends `POST /audio/transcriptions` to its local OpenAI-compatible
server.

Fun-ASR Nano uses the official pinned FunASR llama.cpp/GGUF release. It runs the
native `llama-funasr-cli` executable for each transcription and needs only
Linux x86_64, `curl`, `tar`, `sha256sum`, and `flock`; it does not need Python,
CUDA, or a model server. The first installation downloads the native runtime and
approximately 1.3 GB of GGUF weights. Progress and failures remain visible in
the Voice jobs panel.

Managed installs show separate endpoint/setup and weights rows. Fun-ASR reports
measured byte progress for both downloads; Qwen shows an ASCII activity indicator
for stages whose vLLM installer does not publish a reliable total size.

Fun-ASR MLT uses FunASR's local `funasr-server` with its 800M multilingual
checkpoint. It binds only to `127.0.0.1`, preloads the model once, and the plugin
uses its OpenAI-compatible transcription API internally. The service selects CPU
automatically when CUDA is unavailable.

The selected language is passed to NeMo, Qwen3-ASR, and Fun-ASR MLT as their
documented language hint. The official local Fun-ASR Nano CLI has no language
argument, so that model uses its built-in automatic detection instead.

Qwen3-ASR and local Fun-ASR models use simulated streaming in this plugin: they
repeatedly transcribe audio snapshots.

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

The **cleanup pass** — punctuation, filler words, homophones — is separate from
transcription. It is not local: it runs against the OpenCode server you are
already using, so cleaned dictation goes wherever that server routes it. Remote
cleanup is separate from the local STT runtimes.

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

- `sttTimeoutMs` — timeout for one local service transcription request (default `30000`)
- `sttNemoModel` — default nemo-speech model short name (default `parakeet-tdt`)
- `sttLanguage` — initial transcription language, using a canonical code such as
  `en`, `es`, `zh`, `ja`, or `ko`; defaults to `auto`. It can also be changed from the
  **Transcription language** row in `/voice`
- `autoGain` — measure each recording and boost quiet input (below ~-32 dB RMS)
  before transcription, up to +28 dB with a limiter (default `true`). Toggle
  with `/stt-gain`
- `trimSilence` — remove leading silence from recordings (default `true`). Set
  `false` if recordings are missing the first word or syllable
- `tmpDir` — directory for the temporary recording file (default `/tmp`)

**Live transcription**

- `liveTranscript` — show an interim transcription while recording (default
  `true`)
- `liveTranscriptTarget` — `"prompt"` (default; Claude Code-style, words appear
  in the prompt bar as you speak and are replaced on each refresh, with a brief
  flicker) or `"toast"` (floating in the notification corner, never touches your
  typing). This setting is obeyed as written: if the prompt cannot be updated,
  the live view stops with an error naming the reason rather than quietly moving
  your words to the notification corner. Dictation itself is unaffected — the
  text still lands in the prompt when you release
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
| `/stt-model`  |          | Select local or remote transcription model    |
| `/stt-gain`   |          | Toggle auto-gain                              |
| `/stt-mic`    |          | Select microphone                             |

### The `/voice` menu

On first run `/voice` is a guided setup: choose a language, enter the voice key,
choose hold-to-talk or tap-to-toggle, and select a compatible transcription model.
It then handles prerequisites, downloads, and cleanup-model selection before
showing a localized ready instruction. The selected interface language is stored in
`voice.locale`; the initial transcription language is stored separately in
`stt.language` so advanced settings can change one without unexpectedly changing
the other.

After setup `/voice` opens a settings screen showing every runtime setting with
its current value — talk key, input mode, auto-submit, text cleanup,
transcription model, transcription language, microphone, auto-gain — plus a
"Run setup again" row. Toggles flip in place; pickers return to the screen. The
`/stt-*` commands are shortcuts to the same pickers. Select the `← Back` row or
press `Alt+Left` to return from a sub-screen; `Esc` closes the menu entirely.

Two ways to choose a cleanup model:

- **Test and auto-pick** sends a tiny real cleanup request to each small model (a
  few at a time, so the probes do not trip the rate limit they are measuring) and
  ranks the ones that answered by correction quality then speed. Models that
  failed stay listed below with the reason. Successful results are
  cached for five minutes — the title says how old they are, and **Test again**
  re-checks the connection and re-probes everything.
- **Browse all models** is a `/models`-style picker fed by merged sources (the
  TUI's provider list, `/config/providers` where it exists, the host server's
  `/v1/models`, and the models.dev catalog for providers those lists named). It
  shows only small models by default, with a "Show all models" row at the bottom.

## Voice input modes

- **Push to talk** — hold your configured talk key (default `ctrl+r`): a brief warmup shows
  "keep holding", then recording starts. Release to stop and transcribe. A quick
  single tap is a no-op with a hint toast.
- **Tap to toggle** — tap your configured talk key to start, tap again to stop and transcribe.

Choose **Talk key** in `/voice`, then press the key or modifier combination you
want, such as `F2` or `Ctrl+Shift+K`. The new binding takes effect immediately and
appears in the capture dialog; press Enter to save or Esc to cancel. It persists
through `api.kv`.

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
and restored when dictation finishes. If you edit or delete a previous
dictation, the plugin drops its tracking and the next recording uses the
current prompt contents, so deleted text is not resurrected. Avoid typing while
actually recording; refreshes rewrite the prompt every tick.

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
2. The selected STT backend transcribes locally or through its configured server
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
