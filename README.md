[![CI](https://github.com/renjfk/opencode-voice/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/renjfk/opencode-voice/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/@renjfk/opencode-voice)](https://www.npmjs.com/package/@renjfk/opencode-voice)
[![Downloads](https://img.shields.io/npm/dm/@renjfk/opencode-voice)](https://www.npmjs.com/package/@renjfk/opencode-voice)

# opencode-voice

Speech-to-text dictation plugin for [OpenCode](https://opencode.ai/).

Hold `ctrl+r`, talk, and a live transcription streams into your prompt. When
you release, an LLM cleanup pass fixes punctuation, filler words, and software
engineering homophones ("Jason" to "JSON", "bullion" to "boolean").

Voice input works like Claude Code's `/voice`: activate **hold** mode and hold
`ctrl+r` to talk — an animated "Listening..." indicator stays up while you
speak and a live transcription appears in the prompt — or **tap** mode and tap
to start/stop.
Transcribe locally with [whisper.cpp](https://github.com/ggml-org/whisper.cpp)
(now with Silero VAD to stop silence hallucinations) or
[NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp) running NVIDIA's
Parakeet/Nemotron models, which are more accurate than Whisper and structurally
immune to silence hallucination.

## Install

Add to your `tui.json` (create at `~/.config/opencode/tui.json` if it doesn't
exist). After installing, run `/voice` in OpenCode: **Simple setup**
detects your mic, installs/uses nemo-speech, and points cleanup at the models
you're already logged into OpenCode with (including free opencode Zen models).
**Advanced setup** asks about your language and hardware and recommends an
engine/model accordingly — Parakeet for English, Nemotron or whisper.cpp for
other languages, a small whisper model on modest hardware, or the
transcription API when local compute isn't an option:

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

The plugin records with `sox` and transcribes locally with one of two engines
(selectable at runtime via `/stt-engine`):

- **nemo-speech** (default) via [NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp),
  running NVIDIA Parakeet/Nemotron models - better accuracy than Whisper,
  structurally immune to silence hallucination, and no manual model setup
  (the setup wizard installs it in the background - keep working, it notifies
  when done - and the first transcription downloads the model automatically)
- **whisper.cpp** via a `whisper-cli` binary - the fallback for multilingual
  needs or existing installs (the wizard can download models)
- **transcription API** - any OpenAI-compatible `/audio/transcriptions`
  endpoint, for machines that can't run local models (configure `sttEndpoint`,
  see below)

Install `sox` first (it is covered in the OS-specific whisper sections below),
then run `/voice`.

#### Recommended engine: nemo-speech

[NVIDIA's NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp) runs
Parakeet and Nemotron ASR models locally with CPU/Metal/Vulkan/CUDA backends.
On the HF Open ASR leaderboard, Parakeet TDT 0.6B v3 beats Whisper
large-v3-turbo on English (~6.3% vs ~7.8% WER), and because it is a
transducer (no autoregressive language-model decoder) it **cannot hallucinate
text on silence** the way Whisper does. It also emits punctuation and
capitalization natively.

Install the CLI (macOS/Linux):

```bash
curl -fsSL https://github.com/NVIDIA/NeMo-Speech.cpp/raw/main/scripts/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

Then run `/stt-engine` in OpenCode and pick **nemo-speech**. No manual model
download is needed: the first transcription pulls the pinned GGUF (~700 MB,
SHA-256-verified) into `~/.cache/nemo-speech/models`. Pick a specific model
with `/stt-model`:

- `parakeet-tdt` — Parakeet TDT 0.6B v3, best English accuracy
- `nemotron-3.5` (CLI default) — multilingual streaming
- `nemotron-en` — English streaming
- `parakeet-ctc` — Parakeet CTC 1.1B, English

Smoke-test outside OpenCode:

```bash
sox -d /tmp/smoke.wav trim 0 4   # say something for 4 seconds
nemo-speech transcribe /tmp/smoke.wav
rm /tmp/smoke.wav
```

#### Alternative engine: whisper.cpp

The per-OS sections below install whisper.cpp; the microphone verification
steps apply to both engines.

#### macOS

Install the `whisper-cpp` bottle (ships a `whisper-cli` with Metal enabled on
Apple Silicon) and `sox`:

```bash
brew install whisper-cpp sox
```

Verify your microphone by recording a 3-second clip and playing it back. The
first `sox -d` invocation triggers a macOS microphone permission prompt —
grant it in **System Settings → Privacy & Security → Microphone**, then rerun.
Remove the temp file once you've heard yourself clearly:

```bash
sox -d /tmp/mic-check.wav trim 0 3   # speak for 3 seconds
play /tmp/mic-check.wav              # you should hear yourself
rm /tmp/mic-check.wav                # delete after verification
```

#### Linux (including WSL2)

Install `sox` with its PulseAudio driver (a separate package on Debian/Ubuntu),
the PulseAudio tools so the plugin can enumerate input devices via `pactl`,
and the build tools for whisper.cpp:

```bash
sudo apt install sox libsox-fmt-pulse pulseaudio-utils build-essential cmake
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

Verify your microphone by recording a 3-second clip and playing it back.
Remove the temp file once you've heard yourself clearly; skip building
whisper.cpp until this works, otherwise `/stt-mic` will have nothing to select:

```bash
sox -d /tmp/mic-check.wav trim 0 3   # speak for 3 seconds
play /tmp/mic-check.wav              # you should hear yourself
rm /tmp/mic-check.wav                # delete after verification
```

`whisper-cli` is not packaged for Linux, so build whisper.cpp from source.
Pick **one** of the two builds below.

**CPU build** — works on any machine, adequate for `tiny`/`base`/`small`
models:

```bash
git clone https://github.com/ggml-org/whisper.cpp ~/opt/whisper.cpp
cmake -B ~/opt/whisper.cpp/build -S ~/opt/whisper.cpp \
  -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF
cmake --build ~/opt/whisper.cpp/build -j --target whisper-cli
sudo ln -sf ~/opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
```

**CUDA build** — NVIDIA GPU, ~100× faster encode for `medium`/`large` models.
Check your GPU with `nvidia-smi` and your toolkit with `nvcc --version`, then
pick the arch code from the table:

| GPU family    | Arch      | `CMAKE_CUDA_ARCHITECTURES` | Min. CUDA |
| ------------- | --------- | -------------------------- | --------- |
| RTX 20 / T4   | Turing    | `75`                       | 10.0      |
| RTX 30 / A100 | Ampere    | `86`                       | 11.0      |
| RTX 40 / L40  | Ada       | `89`                       | 11.8      |
| H100          | Hopper    | `90`                       | 12.0      |
| RTX 50 / B100 | Blackwell | `120`                      | 13.0      |

```bash
git clone https://github.com/ggml-org/whisper.cpp ~/opt/whisper.cpp
cmake -B ~/opt/whisper.cpp/build -S ~/opt/whisper.cpp \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_CUDA=ON \
  -DCMAKE_CUDA_ARCHITECTURES=89 \
  -DWHISPER_BUILD_TESTS=OFF
cmake --build ~/opt/whisper.cpp/build -j --target whisper-cli
sudo ln -sf ~/opt/whisper.cpp/build/bin/whisper-cli /usr/local/bin/whisper-cli
```

If you have multiple CUDA toolkits installed (e.g. Blackwell requires CUDA 13
while the default `nvcc` is 12), also pass `-DCMAKE_CUDA_COMPILER=/usr/local/cuda-13.3/bin/nvcc`
to point at the matching `nvcc`. CUDA runtime libraries are resolved via
ldconfig; no `LD_LIBRARY_PATH` is needed.

At runtime the plugin records through sox's `pulseaudio` driver when `pactl`
is available, and falls back to sox's default device otherwise.

#### Whisper model download & smoke test

Download a whisper model to `~/.local/share/whisper-cpp/` (same path on both
OSes):

```bash
mkdir -p ~/.local/share/whisper-cpp
curl -L -o ~/.local/share/whisper-cpp/ggml-large-v3-turbo-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

Also download the Silero VAD model (~860 KB). When present, the plugin passes
`--vad` to `whisper-cli` so silent audio is filtered before decoding — this is
the main defense against Whisper hallucinating text ("Thanks for watching!",
repeated phrases) on silence:

```bash
curl -L -o ~/.local/share/whisper-cpp/ggml-silero-v6.2.0.bin \
  https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin
```

Requires whisper.cpp v1.7.5+ (older builds accept the retry path: the plugin
detects the rejection and re-runs once without VAD). Set the `sttVad: false`
plugin option to disable VAD entirely.

Smoke-test the install by transcribing a short recording:

```bash
sox -d /tmp/smoke.wav trim 0 4   # say something for 4 seconds
whisper-cli -m ~/.local/share/whisper-cpp/ggml-large-v3-turbo-q5_0.bin \
  -f /tmp/smoke.wav -l auto -nt
rm /tmp/smoke.wav
```

Check the first `system_info:` line in the output to confirm the expected
backend is active:

| Install                        | Expect                  |
| ------------------------------ | ----------------------- |
| macOS Homebrew (Apple Silicon) | `METAL = 1`             |
| Linux CUDA build               | `CUDA : ARCHS = <n>`    |
| CPU-only                       | `METAL = 0` / no `CUDA` |

Reference `encode time` on a 4-second clip: CPU `medium` ≈ 15–30 s; CUDA
`medium` ≈ 100–200 ms; CUDA `large-v3-turbo` ≈ 100–300 ms. Apple Silicon
Metal timings are hardware-dependent but typically sub-second. If your GPU
build shows CPU-level timings, the GPU backend failed to load — on Linux,
re-check `nvidia-smi` and rebuild with the arch code from the table above.

### LLM endpoint

The post-dictation cleanup pass (punctuation, filler words, software
engineering homophones) needs an LLM, but nothing to configure: when no
`endpoint` is set, `/voice setup` can point cleanup at the opencode server
you're already running, reusing whatever models you're logged in with -
including free opencode Zen models (your `small_model` is preferred, since
it's OpenCode's own setting for cheap auxiliary work). An explicit
`endpoint`/`model` in `tui.json` always takes precedence; any OpenAI-compatible
endpoint works.

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
- `sttLanguage` _(optional)_ - spoken language passed to local `whisper-cli -l` (default `auto`; any whisper.cpp language code, e.g. `en`, `zh`). Can be changed at runtime via `/stt-language`
- `trimSilence` _(optional)_ - whether to remove leading silence from recordings (default `true`). Set to `false` if your recordings are missing the first word or syllable
- `voiceKey` _(optional)_ - keybind used for voice input (default `ctrl+r`). Accepts OpenCode keybind strings, e.g. `"ctrl+r"`, `"f2"`, or `"<leader>v"`
- `voiceMode` _(optional)_ - default voice input mode when `/voice` has not set one at runtime: `"hold"` or `"tap"` (default `hold`)
- `autoSubmit` _(optional)_ - in `/voice hold` mode, submit the prompt automatically when you release the key (default `false`; tap mode always submits on the second tap)
- `liveTranscript` _(optional)_ - show an interim transcription while recording (default `true`; local engines only)
- `liveTranscriptTarget` _(optional)_ - where interim text appears: `"prompt"` (replaces the prompt text on each refresh, Claude Code-style — text you typed before dictating is stashed and restored afterwards; each refresh briefly flickers) or `"toast"` (default; floating, never touches your typing)
- `liveTranscriptIntervalMs` _(optional)_ - how often the interim transcription refreshes (default `1200`, minimum `600`). Each refresh transcribes ALL audio so far, so the interim text self-corrects as more context arrives; the first words appear almost immediately after recording starts. On release only the audio since the last refresh is transcribed (plus a 1s overlap), then the LLM cleanup pass swaps in — no full re-transcription stall
- `normalizeTimeoutMs` _(optional)_ - how long to wait for the post-release LLM cleanup before falling back to the raw transcription (default `10000`). Prior prompt text stays stashed until the final swap, so keep this low if your normalization endpoint is slow
- `sttNormalize` _(optional)_ - set `false` to disable the LLM cleanup pass entirely (default `true`). When enabled, cleanup is skipped automatically for transcriptions that already look clean (punctuated, no filler words, no likely STT homophones like "locks"/"bullion"), so well-formed dictation finalizes instantly without an LLM round trip
- `sttVad` _(optional)_ - pass Silero VAD flags to `whisper-cli` when a VAD model is present (default `true`)
- `autoGain` _(optional)_ - measure each recording and boost quiet input (below ~-32 dB RMS) before transcription, up to +28 dB with a limiter (default `true`). Toggle at runtime with `/stt-gain`
- `sttEndpoint` _(optional)_ - OpenAI-compatible base URL with `/audio/transcriptions` support, enabling the API engine
- `sttModel` _(optional)_ - model name for the API engine (default: `whisper-large-v3-turbo`)
- `sttApiKeyEnv` _(optional)_ - environment variable containing the API-engine key
- `sttEngine` _(optional)_ - default transcription engine: `"nemo"`, `"whisper"`, or `"api"` (default: `nemo` when `nemo-speech` is installed, else `whisper`, else `api` when configured). `/stt-engine` overrides at runtime
- `sttNemoModel` _(optional)_ - default nemo-speech model short name (default: the CLI's own default, `nemotron-3.5`). For English dictation, `parakeet-tdt` is faster and more accurate

### Logging

The plugin writes diagnostics through OpenCode's structured app logger. If this plugin is not working with your setup, check the OpenCode log file and, optionally, enable debug mode. See the [OpenCode Docs](https://opencode.ai/docs/troubleshooting/#logs) for details.

Routine plugin diagnostics use `debug`; recoverable issues use `warn`; failed
child processes, API calls, or unexpected exceptions use `error`.

### Fully local / offline cleanup

The LLM cleanup pass works with any OpenAI-compatible endpoint, including
local servers, so the whole plugin can run offline (transcription already is
local via whisper.cpp or nemo-speech). With [LM Studio](https://lmstudio.ai)
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

| Command         | Keybind  | Description                                   |
| --------------- | -------- | --------------------------------------------- |
| `/voice`        |          | Voice input mode: hold (push-to-talk) or tap  |
| `/stt-record`   | `ctrl+r` | Record via active voice mode, then transcribe |
| `/stt-submit`   |          | Stop recording, transcribe, and submit        |
| `/stt-stop`     |          | Cancel recording                              |
| `/stt-engine`   |          | Select engine: nemo / whisper / API           |
| `/stt-model`    |          | Select model for the active engine            |
| `/stt-gain`     |          | Toggle auto-gain                              |
| `/stt-language` |          | Select transcription language (whisper only)  |
| `/stt-mic`      |          | Select microphone                             |

#### Voice input modes (`/voice`)

Mirrors Claude Code's voice dictation:

- **Hold (push-to-talk)** — hold `ctrl+r` (or your `voiceKey`): a brief warmup
  shows "keep holding", then recording starts. Release to stop, transcribe,
  and insert text into the prompt (add `"autoSubmit": true` to send it).
  A quick single tap is a no-op with a hint toast.
- **Tap** — tap `ctrl+r` to start recording, tap again to stop, transcribe,
  and submit.

Hold detection works by watching key-repeat events, so it needs a terminal
that emits auto-repeat while a key is held (virtually all do; if yours does
not, use tap mode). The mode persists across sessions via `api.kv`.

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
models like Parakeet TDT; disabled automatically for the API engine to
avoid per-tick uploads). Set `liveTranscript: false` to turn it off entirely.

`/stt-mic` lists CoreAudio input devices on macOS, and PulseAudio sources on
Linux (via `pactl`, monitor sources excluded). On systems without a supported
device listing, "System default" uses sox's default device (`sox -d`).

`/stt-language` offers a curated list of common languages (plus auto-detect)
and only affects local `whisper-cli` transcription, not nemo-speech.
Languages outside the list can be set via the `sttLanguage` plugin option.

## How it works

### STT pipeline

1. `sox` records audio from your microphone (CoreAudio on macOS, PulseAudio on
   Linux when `pactl` is available, sox default device otherwise)
2. The active engine transcribes locally: `nemo-speech` (Parakeet/Nemotron)
   or `whisper-cli` (with Silero VAD pre-filtering so silence never reaches
   the decoder)
3. LLM normalizes the transcription: fixes punctuation, removes filler words,
   corrects software engineering homophones ("Jason" to "JSON", "bullion" to
   "boolean", etc.)
4. Cleaned text is appended to the OpenCode prompt, or submitted immediately
   in tap mode / hold mode with `autoSubmit`. If cleanup fails (e.g. LLM
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

With `/voice hold` mode the built-in `ctrl+r` push-to-talk covers this flow,
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
