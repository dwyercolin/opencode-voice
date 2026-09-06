// Speech-to-text: sox recording, nemo-speech transcription (Parakeet /
// Nemotron), LLM cleanup, and Claude Code-style voice input modes (/voice).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";
import { getActiveSessionTitle } from "./session.js";
import { createHoldDetector } from "./voice-mode.js";
import { applyAutoGain } from "./audio.js";
import { createMenu, shortLabel } from "./menu.js";
import { createVoiceSetup } from "./setup.js";

import {
  NEMO_MODELS,
  hasBinary,
  sliceWavFrom,
  snapshotPartialWav,
  transcribeNemo,
} from "./engines.js";

let pluginOpts = {};

// File-based trace of the dictation pipeline: opencode's app logger filters
// debug output, so these land in a file instead. Off unless `debugLog: true`
// is set in plugin options - the trace quotes what was dictated, and tmpdir
// is world-readable on most systems.
const DEBUG_LOG = path.join(os.tmpdir(), "opencode-voice-debug.log");
function debugLog(message) {
  if (!pluginOpts?.debugLog) return;
  try {
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}

const WAV_FILENAME = "opencode-stt.wav";
const PARTIAL_FILENAME = "opencode-stt-partial.wav";
const GAIN_FILENAME = "opencode-stt-gain.wav";
const PARTIAL_GAIN_FILENAME = "opencode-stt-partial-gain.wav";
const TAIL_FILENAME = "opencode-stt-tail.wav";
const TAIL_GAIN_FILENAME = "opencode-stt-tail-gain.wav";
const LIVE_INTERVAL_MS = 1200;
let tmpDir = "/tmp";

// ---- Audio backend detection (coreaudio / pulseaudio / sox default) ----

function detectAudioBackend() {
  if (process.platform === "darwin") return "coreaudio";
  try {
    execSync("pactl --version", { stdio: "ignore", timeout: 3000 });
    return "pulseaudio";
  } catch {
    return "default";
  }
}

// ---- Audio server diagnostics ----

export function isWSL() {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

// Unlike `pactl --version`, `pactl info` actually connects to the server.
function pulseServerHealth() {
  try {
    execSync("pactl info", { stdio: "ignore", timeout: 3000 });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// User-facing hint for missing devices / recording failures. On WSL the audio
// server is WSLg's PulseAudio, which can wedge and needs a `wsl --shutdown`.
export function buildAudioHint({ backend, serverOk, isWsl }) {
  if (backend !== "pulseaudio") return "No input devices found";
  if (serverOk) return "No input devices found - check your audio input source configuration";
  if (isWsl) {
    return 'Audio server unreachable. On WSL, WSLg\'s PulseAudio may be stuck - run "wsl --shutdown" on Windows, then reopen Ubuntu';
  }
  return "Audio server unreachable - check that PipeWire/PulseAudio is running";
}

// Appends a server-health hint to recording failure messages when the
// PulseAudio server is unreachable (e.g. wedged WSLg on WSL).
function audioFailureSuffix(backend) {
  if (backend !== "pulseaudio") return "";
  if (pulseServerHealth().ok) return "";
  return `. ${buildAudioHint({ backend, serverOk: false, isWsl: isWSL() })}`;
}

// Input device descriptors: name is the value passed to sox, label is shown in
// the UI. pactl gives both a human description ("Brio 100 Mono") and a device
// id ("alsa_input.usb-046d_Brio_100_254AP3-02.mono-fallback"); the id is only
// useful to sox, so it stays out of the label unless it is all we have.

/** Strip the routing prefix/suffix off a raw pactl id, for when it is the label. */
export function shortDeviceId(name) {
  return String(name || "")
    .replace(/^alsa_(input|output)\./, "")
    .replace(/\.[^.]+$/, "");
}

/**
 * Two identical webcams give two identical descriptions, so a label that
 * appears more than once gets its device id back to stay selectable.
 */
export function disambiguateLabels(devices) {
  const counts = new Map();
  for (const d of devices) counts.set(d.label, (counts.get(d.label) ?? 0) + 1);
  return devices.map((d) =>
    counts.get(d.label) > 1 ? { ...d, label: `${d.label} (${shortDeviceId(d.name)})` } : d,
  );
}

export function parsePactlSources(jsonText) {
  const data = JSON.parse(jsonText);
  const devices = (Array.isArray(data) ? data : [])
    .filter((s) => s?.name && !s.name.endsWith(".monitor"))
    .map((s) => ({ name: s.name, label: s.description || shortDeviceId(s.name) }));
  return disambiguateLabels(devices);
}

export function parsePactlSourcesShort(text) {
  // The short listing has no descriptions at all, so ids are the only labels.
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((name) => name && !name.endsWith(".monitor"))
    .map((name) => ({ name, label: shortDeviceId(name) }));
}

function listInputDevices(backend) {
  if (backend === "coreaudio") {
    try {
      const json = execSync("system_profiler SPAudioDataType -json 2>/dev/null", {
        encoding: "utf8",
        timeout: 5000,
      });
      const data = JSON.parse(json);
      return (data.SPAudioDataType?.[0]?._items || [])
        .filter((d) => d.coreaudio_input_source != null)
        .map((d) => {
          const name = d.coreaudio_device_name || d._name;
          return { name, label: name };
        });
    } catch {
      return [];
    }
  }
  if (backend === "pulseaudio") {
    try {
      const json = execSync("pactl -f json list sources 2>/dev/null", {
        encoding: "utf8",
        timeout: 5000,
      });
      return parsePactlSources(json);
    } catch {
      try {
        const out = execSync("pactl list sources short 2>/dev/null", {
          encoding: "utf8",
          timeout: 5000,
        });
        return parsePactlSourcesShort(out);
      } catch {
        return [];
      }
    }
  }
  return [];
}

export function buildRecordArgs(backend, mic) {
  if (backend === "pulseaudio") return ["-t", "pulseaudio", mic || "default"];
  if (backend === "coreaudio" && mic) return ["-t", "coreaudio", mic];
  return ["-d"];
}

// ---- Recording state and control ----

let soxProc = null;
let soxStderr = "";
let recording = false;
let processing = false;

function forceKillSox(logger) {
  if (soxProc) {
    try {
      process.kill(soxProc.pid, "SIGKILL");
      logger?.log("STT", `Killed sox pid=${soxProc.pid}`, "debug");
    } catch {}
    soxProc = null;
  }
  try {
    execSync("pkill -9 -f 'sox.*opencode-stt'", { stdio: "ignore" });
  } catch {}
}

function startRecording(kv, backend, toast, logger, trimSilence = true) {
  if (soxProc) {
    logger?.log("STT", "Start recording skipped: sox already running", "debug");
    return;
  }

  const wavFile = path.join(tmpDir, WAV_FILENAME);
  forceKillSox(logger);
  try {
    fs.unlinkSync(wavFile);
  } catch {}

  soxStderr = "";
  const mic = kv.get("stt.mic", "") || null;
  const inputArgs = buildRecordArgs(backend, mic);
  logger?.log(
    "STT",
    `Starting recording backend=${backend} mic=${mic || "system default"}`,
    "debug",
  );

  const silenceArgs = trimSilence ? ["silence", "1", "0.1", "1%"] : [];
  soxProc = spawn(
    "sox",
    [...inputArgs, "-r", "16000", "-c", "1", "-b", "16", wavFile, ...silenceArgs],
    {
      stdio: ["ignore", "ignore", "pipe"],
      detached: false,
    },
  );

  soxProc.stderr.on("data", (chunk) => {
    soxStderr += chunk.toString();
  });

  soxProc.on("error", (err) => {
    soxProc = null;
    logger?.log("STT", `Recording failed: ${err.message}`, "error");
    if (recording) {
      recording = false;
      stopLiveTranscript();
      liveHooks?.stopIndicator?.();
      abandonLivePrompt(logger, true).catch(() => {});
      toast(`Recording failed: ${err.message}${audioFailureSuffix(backend)}`, "error");
    }
  });

  soxProc.on("exit", (code) => {
    soxProc = null;
    logger?.log(
      "STT",
      `sox exited code=${code} stderr=${soxStderr.trim()}`,
      code === 0 || code === null ? "debug" : "warn",
    );
    if (recording && code !== 0 && code !== null && !processing) {
      recording = false;
      stopLiveTranscript();
      liveHooks?.stopIndicator?.();
      abandonLivePrompt(logger, true).catch(() => {});
      const errLine = soxStderr.trim().split("\n").pop();
      toast(
        `Recording error: ${errLine || `sox exited (code=${code})`}${audioFailureSuffix(backend)}`,
        "error",
      );
    }
  });

  recording = true;
  liveEpoch++;
  liveText = null;
  liveTextDisplayed = null;
  liveSnapshotFileBytes = null;
  // Stash any pre-existing prompt text before interim text is written, so
  // refresh clears only ever remove our own text. The stash must wait for
  // the TUI to sync its prompt state after our previous append (render-idle
  // callback), or it would capture stale state and the finalize-time pop
  // would restore text missing the previous dictation.
  if (liveTarget() === "prompt" && liveHooks.enabled()) {
    const settleDelay = Math.max(150, lastPromptMutationAt + STASH_SETTLE_MS - Date.now());
    debugLog(
      `stash scheduled in ${settleDelay}ms (last mutation ${Date.now() - lastPromptMutationAt}ms ago)`,
    );
    liveStashPromise = new Promise((resolve) => {
      setTimeout(() => {
        stashPromptForDictation(logger).then(resolve, resolve);
      }, settleDelay);
    });
  }
  startLiveTranscript(kv, logger);
}

function stopRecording(logger) {
  logger?.log("STT", "Stopping recording", "debug");
  if (soxProc) soxProc.kill("SIGINT");
}

async function waitForSoxExit(logger, timeoutMs = 2000) {
  const start = Date.now();
  while (soxProc && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (soxProc) {
    logger?.log("STT", "sox did not stop before timeout", "warn");
    forceKillSox(logger);
  }
}

// ---- Live partial transcription ----
//
// While recording, periodically snapshot the in-progress WAV (header patched
// so it decodes cleanly), run a one-shot transcription of ALL audio so far,
// and surface the interim text via toast or directly in the prompt
// (Claude Code-style). Because every pass covers the full recording, the
// interim text self-corrects: punctuation and earlier words are re-decided
// with more context each refresh.
//
// The TUI RPC surface can only append text at the end of the prompt or clear
// it entirely - there is no atomic replace - so each in-prompt refresh is a
// clear + append pair (a brief flicker, accepted for accuracy). Everything
// the user typed before dictating is stashed first via the TUI's own
// prompt.stash command and restored when dictation finishes, so refreshes
// only ever clear the plugin's own interim text.
//
// On release there is no full re-transcription stall: only the audio since
// the last snapshot (minus a 1s overlap for context) is transcribed, the
// overlap's words are deduplicated against the interim text, and the result
// is LLM-normalized and swapped in - typically ~1-2s total.
//
// Concurrency: partials run on a timer while the pipeline runs on release.
// An epoch counter invalidates in-flight partials when a recording ends or a
// pipeline starts, and a promise mutex serializes every prompt mutation, so a
// late partial cannot interleave with the final swap and duplicate text.

let liveTimer = null;
let liveBusy = false;
// Latest interim transcription of the full recording so far (null = none yet).
// Tracked in both prompt and toast modes so the release path can skip a full
// re-transcription.
let liveText = null;
// What the prompt currently displays (differs from liveText in toast mode);
// unchanged refreshes are skipped to avoid needless flicker.
let liveTextDisplayed = null;
// Dictation text the plugin has appended to the prompt and believes is still
// there, accumulated across dictations until a submit. The TUI's prompt STATE
// only syncs what the user types - RPC-appended text never reaches it - so
// prompt.stash cannot preserve our text; the plugin re-appends this itself
// after every stash pop. Reset when the prompt is submitted.
let pluginPromptText = null;
// Whole-file byte size of the WAV at the last successful partial pass; the
// release path only transcribes audio captured after this point.
let liveSnapshotFileBytes = null;
// True after prompt.stash ran at recording start.
let liveStashed = false;
// Pending prompt.stash call from recording start; awaited before the first
// interim append and before any restore so operations stay ordered.
let liveStashPromise = null;
// Bumped on every recording start and pipeline start; partials capture it and
// discard their results if the world moved on while they were in flight.
let liveEpoch = 0;
// Serializes all prompt mutations (partial refreshes, final swap, restores).
let promptMutex = Promise.resolve();
// Time of the last prompt mutation the plugin made. appendPrompt's effect on
// the TUI's prompt STATE (what prompt.stash captures) syncs asynchronously
// via a render-idle callback, so a prompt.stash issued right after an append
// captures stale state and loses the previous dictation. Stashing waits for
// STASH_SETTLE_MS after the last mutation.
let lastPromptMutationAt = 0;
const STASH_SETTLE_MS = 450;
// Upper bound on the post-release LLM cleanup wait before falling back to the
// raw transcription (the prompt holds only interim text while waiting, since
// prior prompt content stays stashed until the final swap).
const DEFAULT_NORMALIZE_TIMEOUT_MS = 10000;
let livePromptBroken = false;
let liveHooks = null;

// Bytes per second of 16 kHz mono 16-bit PCM; the release pass re-transcribes
// this much audio before the last snapshot so the tail chunk has left context.
const TAIL_OVERLAP_BYTES = 32000;

function liveTarget() {
  if (livePromptBroken) return "toast";
  if (liveHooks?.target === "prompt" && typeof liveHooks.client.tui.clearPrompt === "function") {
    return "prompt";
  }
  return "toast";
}
function stopLiveTranscript() {
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
  }
}

// Serialize fn against all other prompt mutations.
function withPromptLock(fn) {
  const run = promptMutex.then(fn);
  promptMutex = run.then(
    () => {},
    () => {},
  );
  return run;
}

// Normalize a word for overlap comparison: case-insensitive, punctuation-free.
function normalizeLiveWord(word) {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// The release pass re-transcribes from (last snapshot - overlap) onwards, so
// the tail text usually repeats the last words of the interim text. Strip the
// longest run of leading tail words that matches a trailing run of the
// previous text and return the rest to append.
export function stripOverlappingWords(previousText, tailText, maxWindow = 6) {
  const tailWords = tailText.split(/\s+/).filter(Boolean);
  if (!previousText) return tailText;
  const prevWords = previousText.split(/\s+/).filter(Boolean);
  const maxK = Math.min(prevWords.length, tailWords.length, maxWindow);
  let best = 0;
  for (let k = 1; k <= maxK; k++) {
    let match = true;
    for (let i = 0; i < k; i++) {
      if (
        normalizeLiveWord(prevWords[prevWords.length - k + i]) !== normalizeLiveWord(tailWords[i])
      ) {
        match = false;
        break;
      }
    }
    if (match) best = k;
  }
  return tailWords.slice(best).join(" ");
}

function countPunctuation(text) {
  return (text.match(/[.!?,;:]/g) || []).length;
}

// Raw text that already looks clean skips the LLM normalization pass
// entirely: measured 4-26s per call on a slow endpoint, usually returning the
// input unchanged when the engine already emitted punctuated text. Text is
// "unclean" when it has filler words, likely STT homophone errors, or is
// missing terminal punctuation / leading capitalization.
const STT_FILLER_PATTERN = /\b(um+|uh+|erm|hmm+|you know|i mean)\b/i;
const STT_HOMOPHONE_PATTERN =
  /\b(locks|jason|bullion|cash|rap|talker|types creep|type script|app and|a sink|sink|doc|bite)\b/i;

export function needsNormalization(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (!/[.!?]$/.test(trimmed)) return true;
  if (/^[a-z]/.test(trimmed)) return true;
  if (STT_FILLER_PATTERN.test(trimmed)) return true;
  if (STT_HOMOPHONE_PATTERN.test(trimmed)) return true;
  return false;
}

// Join accumulated prompt text with an addition, handling nulls.
export function combinePromptText(base, addition) {
  if (!base) return addition;
  if (!addition) return base;
  return `${base} ${addition}`;
}

function normalizedWords(text) {
  return text.split(/\s+/).filter(Boolean).map(normalizeLiveWord);
}

// Engines occasionally re-emit the same audio without punctuation (observed
// with parakeet on growing partials). When the fresh partial says the same
// words but drops punctuation the displayed text already had, keep the
// punctuated version instead of visibly downgrading.
export function preferPunctuatedPartial(currentText, freshText) {
  if (!currentText) return freshText;
  const cur = normalizedWords(currentText);
  const fresh = normalizedWords(freshText);
  const sameWords =
    cur.length === fresh.length ||
    (fresh.length === cur.length + 1 && fresh.slice(0, cur.length).join(" ") === cur.join(" "));
  if (sameWords && countPunctuation(currentText) > countPunctuation(freshText)) {
    return currentText;
  }
  return freshText;
}

// Run a TUI palette command (e.g. prompt.stash) through executeCommand,
// probing both RPC argument shapes like appendPrompt. Returns false when the
// method is missing or the call failed (older TUIs degrade gracefully).
async function execTuiCommand(client, command, logger) {
  if (typeof client.tui.executeCommand !== "function") {
    debugLog(`execTuiCommand(${command}): executeCommand unavailable`);
    return false;
  }
  let result = await client.tui.executeCommand({ body: { command } });
  if (result?.error?.data?.message === "Expected object, got undefined") {
    result = await client.tui.executeCommand({ command });
  }
  if (result?.error) {
    debugLog(`execTuiCommand(${command}): FAILED ${JSON.stringify(result.error).slice(0, 200)}`);
    logger?.log("STT", `TUI command ${command} failed`, "warn");
    return false;
  }
  debugLog(`execTuiCommand(${command}): ok`);
  return true;
}

// Stash whatever is in the prompt (user-typed text) before interim text is
// appended, so the end-of-pipeline clear only ever removes our own text.
async function stashPromptForDictation(logger) {
  try {
    if (!liveHooks || liveStashed) return liveStashed;
    liveStashed = await execTuiCommand(liveHooks.client, "prompt.stash", logger);
    debugLog(`stashPromptForDictation: ${liveStashed ? "prompt stashed" : "stash unavailable"}`);
    return liveStashed;
  } catch {
    return false;
  }
}

async function clearPromptBestEffort(logger) {
  try {
    await liveHooks.client.tui.clearPrompt();
    return true;
  } catch (err) {
    livePromptBroken = true;
    debugLog(`clearPrompt THREW ${err.message} - falling back to toast`);
    logger?.log(
      "STT",
      `clearPrompt failed, falling back to toast live transcript: ${err.message}`,
      "warn",
    );
    return false;
  }
}

// End-of-pipeline swap: clear the interim text (the prompt holds only our
// appended text - user text is stashed), restore the stashed user text. The
// caller then re-appends the accumulated dictation text plus the new final
// after it. Returns { swapped } telling the caller whether the prompt was
// cleared/restored (false = the old prompt content is still sitting there and
// must not be re-appended).
async function finalizeLivePrompt(logger) {
  return withPromptLock(async () => {
    if (liveStashPromise) await liveStashPromise;
    const stashed = liveStashed;
    const hadInterim = liveTextDisplayed != null;
    liveText = null;
    liveTextDisplayed = null;
    liveStashed = false;
    liveStashPromise = null;
    if (!liveHooks || (!stashed && !hadInterim)) return { swapped: false };
    debugLog(`finalizeLivePrompt: stashed=${stashed} hadInterim=${hadInterim}`);
    const cleared = await clearPromptBestEffort(logger);
    if (stashed) {
      await execTuiCommand(liveHooks.client, "prompt.stash.pop", logger);
    }
    return { swapped: stashed || cleared };
  });
}

// Abandon the dictation (cancel, recording failure, pipeline error): clear
// the interim text, restore the user's stashed text, and re-append the
// accumulated dictation text (plus the raw interim with keepInterim - on
// failure it may be the only record of what was said).
async function abandonLivePrompt(logger, keepInterim = false) {
  return withPromptLock(async () => {
    if (liveStashPromise) await liveStashPromise;
    const interim = liveText;
    const stashed = liveStashed;
    liveText = null;
    liveTextDisplayed = null;
    liveStashed = false;
    liveStashPromise = null;
    if (!liveHooks) return;
    if (!stashed && !interim && !pluginPromptText) return;
    debugLog(
      `abandonLivePrompt: stashed=${stashed} interim=${interim?.length || 0} keep=${keepInterim} base=${pluginPromptText?.length || 0}`,
    );
    if (stashed) {
      await clearPromptBestEffort(logger);
      await execTuiCommand(liveHooks.client, "prompt.stash.pop", logger);
      const restore = combinePromptText(pluginPromptText, keepInterim ? interim : null);
      if (restore) {
        try {
          await appendTranscription(liveHooks.client, restore, false);
        } catch {}
      }
    } else if (keepInterim) {
      // Prompt still shows base+interim from the refreshes (or was never
      // touched when no partial ran) - keep it and record the interim.
      if (interim) pluginPromptText = combinePromptText(pluginPromptText, interim);
    } else {
      // Cancel without stash protection: rebuild the accumulated text alone.
      await clearPromptBestEffort(logger);
      if (pluginPromptText) {
        try {
          await appendTranscription(liveHooks.client, pluginPromptText, false);
        } catch {}
      }
    }
    if (keepInterim && interim) {
      pluginPromptText = combinePromptText(pluginPromptText, interim);
    }
  });
}

function autoGainEnabled(kv) {
  return kv.get("stt.autogain", pluginOpts.autoGain !== false);
}

async function runLivePartial(kv, logger) {
  if (liveBusy || !recording || processing || !liveHooks) return;
  liveBusy = true;
  const epoch = liveEpoch;
  try {
    const src = path.join(tmpDir, WAV_FILENAME);
    const dst = path.join(tmpDir, PARTIAL_FILENAME);
    let snapshotBytes;
    try {
      snapshotBytes = fs.statSync(src).size;
    } catch {
      return;
    }
    if (!snapshotPartialWav(src, dst)) return;
    const prepared = await applyAutoGain(dst, path.join(tmpDir, PARTIAL_GAIN_FILENAME), {
      enabled: autoGainEnabled(kv),
      logger,
    });
    const result = await transcribeWithEngine(kv, logger, prepared.file);
    // Recording may have ended (or a new one started) while this partial was
    // in flight; the epoch check inside the lock discards stale results.
    if (!recording || processing || epoch !== liveEpoch) return;
    if (result?.error) return;

    await withPromptLock(async () => {
      if (epoch !== liveEpoch || processing) return;
      // Track how far we have transcribed even when the pass produced no
      // text (silence), so the release pass never re-transcribes old audio.
      liveSnapshotFileBytes = snapshotBytes;
      if (!result.text) return;
      const preferred = preferPunctuatedPartial(liveText, result.text);
      liveText = preferred;
      if (liveTarget() === "prompt") {
        // Ensure the record-start stash has settled before the first refresh.
        if (liveStashPromise) await liveStashPromise;
        // Rebuild the prompt as [accumulated dictation text][live text] so
        // previous dictations stay visible while the live region corrects.
        const displayText = combinePromptText(pluginPromptText, preferred);
        if (displayText === liveTextDisplayed) return; // unchanged, no flicker
        debugLog(
          `partial refresh (${displayText.length} chars): ${JSON.stringify(displayText.slice(0, 60))}`,
        );
        // On a failed clear, appending would duplicate the old interim text;
        // keep the stale text and let the final swap replace it.
        if (!(await clearPromptBestEffort(logger))) return;
        await appendTranscription(liveHooks.client, displayText, false);
        debugLog("partial refresh: ok");
        liveTextDisplayed = displayText;
      } else {
        liveHooks.toast(`● ${preferred}`);
      }
    });
    logger?.log("STT", `Live partial chars=${result.text?.length || 0}`, "debug");
  } catch {
    // Partial display is best-effort; never surface errors mid-recording
  } finally {
    liveBusy = false;
  }
}

function startLiveTranscript(kv, logger) {
  if (liveTimer || processing) return;
  if (!liveHooks?.enabled()) return;
  const interval = Math.max(600, liveHooks.interval);
  liveTimer = setInterval(() => {
    runLivePartial(kv, logger).catch(() => {});
  }, interval);
  // First words should appear almost immediately, not after a full interval.
  setTimeout(() => {
    runLivePartial(kv, logger).catch(() => {});
  }, 150);
}

// ---- Engine resolution ----

function getNemoModel(kv) {
  return kv.get("stt.nemo.model", pluginOpts.sttNemoModel || "") || "";
}

async function transcribeWithEngine(kv, logger, wavFile = path.join(tmpDir, WAV_FILENAME)) {
  if (!fs.existsSync(wavFile)) {
    logger?.log("STT", `Recording file missing: ${wavFile}`, "error");
    return { error: "No recording file - sox may have failed to capture audio" };
  }
  if (fs.statSync(wavFile).size <= 44) {
    logger?.log("STT", `Recording file empty: ${wavFile}`, "warn");
    return { error: "Recording is empty - no audio captured" };
  }

  if (!hasBinary("nemo-speech")) {
    return {
      error:
        "nemo-speech not found on PATH - install it (github.com/NVIDIA/NeMo-Speech.cpp) or run /voice setup",
    };
  }
  return await transcribeNemo({ wavFile, model: getNemoModel(kv), logger });
}

// ---- Normalization pipeline ----

const STT_SYSTEM_PROMPT = `You are a speech-to-text normalizer for a coding assistant CLI.

Clean up raw speech transcription into a clear, well-punctuated prompt. Rules:
- Fix punctuation, capitalization, and grammar
- Remove filler words (um, uh, like, you know, etc.)
- Keep technical terms, file names, and code references exact
- If the user is dictating code, format it appropriately
- Use the session context above to resolve ambiguous references (e.g. "that function", "the file", "it")
- Output ONLY the cleaned text, nothing else
- Do not add any commentary or explanation
- Keep the user's intent and meaning intact

CRITICAL DOMAIN CORRECTIONS - Fix common STT homophone errors in software engineering contexts:
- "locks" -> "logs" (unless explicitly talking about mutexes/concurrency)
- "note" / "no" -> "node"
- "app and" -> "append"
- "sink" -> "sync"
- "a sink" -> "async"
- "doc" / "talker" -> "docker"
- "cash" -> "cache"
- "rap" -> "wrap"
- "Jason" -> "JSON"
- "get" -> "Git"
- "react" -> "React"
- "types creep" / "type script" -> "TypeScript"
- "bite" -> "byte"
- "string" -> "String"
- "int" -> "Int"
- "bullion" -> "boolean"

Rely heavily on context to fix words that sound similar to programming terminology.`;

async function normalizeTranscription(complete, rawText, sessionTitle, systemPrompt, logger) {
  const contextLine = sessionTitle ? ` The user is currently working on: "${sessionTitle}"` : "";
  const system = `${systemPrompt}${contextLine}`;

  logger?.log("STT", `Normalizing transcription chars=${rawText.length}`, "debug");
  const result = await complete({
    system,
    prompt: `Clean up this speech-to-text transcription:\n\n${rawText}`,
  });
  return result;
}

async function appendTranscription(client, text, submit) {
  debugLog(`appendTranscription: enter chars=${text?.length || 0} submit=${submit}`);
  let appendResult = await client.tui.appendPrompt({ body: { text } });
  debugLog(`appendTranscription: body-shape result=${JSON.stringify(appendResult)?.slice(0, 300)}`);

  if (appendResult?.error?.data?.message === "Expected object, got undefined") {
    appendResult = await client.tui.appendPrompt({ text });
    debugLog(
      `appendTranscription: flat-shape result=${JSON.stringify(appendResult)?.slice(0, 300)}`,
    );
  }

  if (appendResult?.error) {
    debugLog(`appendTranscription: FAILED - ${JSON.stringify(appendResult.error)?.slice(0, 300)}`);
    throw new Error(
      `appendPrompt failed: ${appendResult.error.data?.message || appendResult.error.name}`,
    );
  }

  // Record when the prompt last changed so the next prompt.stash waits for
  // the TUI's async state sync (render-idle -> onContentChange) to settle.
  lastPromptMutationAt = Date.now();

  if (submit) {
    await client.tui.submitPrompt();
  }
}

// Transcribe only the audio captured after the last live partial (minus a
// short overlap for decoding context), deduplicate the overlap against the
// interim text, and return the combined raw text. Falls back to transcribing
// the full recording when no partial ever ran (live transcript disabled,
// engine too slow, or a very short utterance).
async function collectFinalTranscript(kv, logger, toast) {
  const wavFile = path.join(tmpDir, WAV_FILENAME);

  if (liveSnapshotFileBytes == null) {
    const prepared = await applyAutoGain(wavFile, path.join(tmpDir, GAIN_FILENAME), {
      enabled: autoGainEnabled(kv),
      logger,
    });
    if (prepared.gainDb > 0) {
      toast(`Quiet mic - applied +${prepared.gainDb}dB gain`);
    }
    const result = await transcribeWithEngine(kv, logger, prepared.file);
    debugLog(`pipeline: full transcription result=${JSON.stringify(result).slice(0, 200)}`);
    return result;
  }

  // Tail-only pass: the interim text already covers audio up to the last
  // snapshot; re-decode just the end of the utterance.
  const startFileByte = Math.max(0, liveSnapshotFileBytes - TAIL_OVERLAP_BYTES);
  const tailFile = path.join(tmpDir, TAIL_FILENAME);
  const tailBytes = sliceWavFrom(wavFile, tailFile, startFileByte);
  if (tailBytes < 0) {
    debugLog("pipeline: no tail audio beyond last snapshot, using interim text");
    return { text: liveText || "" };
  }
  debugLog(`pipeline: tail pass bytes=${tailBytes} (from file offset ${startFileByte})`);
  const prepared = await applyAutoGain(tailFile, path.join(tmpDir, TAIL_GAIN_FILENAME), {
    enabled: autoGainEnabled(kv),
    logger,
  });
  const tail = await transcribeWithEngine(kv, logger, prepared.file);
  debugLog(`pipeline: tail result=${JSON.stringify(tail).slice(0, 200)}`);
  if (tail.error) {
    // The tail is best-effort; keep the interim text rather than failing.
    return { text: liveText || "" };
  }
  if (!tail.text) {
    return { text: liveText || "" };
  }
  const deduped = stripOverlappingWords(liveText, tail.text);
  debugLog(
    `pipeline: tail dedup ${tail.text.length} chars -> ${deduped.length} chars: ${JSON.stringify(deduped.slice(0, 60))}`,
  );
  const combined = liveText ? `${liveText} ${deduped}`.trim() : deduped;
  return { text: combined };
}

async function doTranscribePipeline(
  kv,
  complete,
  client,
  toast,
  systemPrompt,
  submit = false,
  logger,
) {
  processing = true;
  liveEpoch++;
  try {
    logger?.log("STT", `Pipeline started submit=${submit}`, "debug");
    liveHooks?.stopIndicator?.();
    stopLiveTranscript();
    stopRecording(logger);
    await waitForSoxExit(logger);

    toast("Finishing...");
    const result = await collectFinalTranscript(kv, logger, toast);
    debugLog(`pipeline: final transcript chars=${result.text?.length || 0} stashed=${liveStashed}`);

    // On failure or silence, restore any stashed prompt text and keep the raw
    // interim text - it may be the only copy of what was said.
    if (result.error) {
      logger?.log("STT", `Transcription failed: ${result.error}`, "error");
      debugLog(`pipeline: transcription ERROR: ${result.error}`);
      toast(result.error, "error");
      await abandonLivePrompt(logger, true);
      return;
    }
    if (!result.text) {
      logger?.log("STT", "Transcription produced no text", "warn");
      debugLog("pipeline: no speech detected (empty text), keeping interim");
      toast("No speech detected", "warning");
      await abandonLivePrompt(logger, true);
      return;
    }

    let finalText = result.text;
    const normalizeEnabled = pluginOpts.sttNormalize !== false;
    if (!normalizeEnabled) {
      debugLog("pipeline: normalization disabled (sttNormalize:false)");
    } else if (!needsNormalization(result.text)) {
      debugLog("pipeline: raw text already clean - skipping LLM cleanup");
      logger?.log("STT", "Raw transcription already clean, skipping normalization", "debug");
    } else {
      toast("Cleaning up...");
      const sessionTitle = await getActiveSessionTitle(client);
      const normalizeTimeoutMs =
        Number(pluginOpts.normalizeTimeoutMs) || DEFAULT_NORMALIZE_TIMEOUT_MS;
      let llmResult;
      try {
        llmResult = await Promise.race([
          normalizeTranscription(complete, result.text, sessionTitle, systemPrompt, logger),
          new Promise((resolve) =>
            setTimeout(() => resolve({ text: null, error: "timeout" }), normalizeTimeoutMs),
          ),
        ]);
      } catch (err) {
        llmResult = { text: null, error: err.message };
      }
      debugLog(
        `pipeline: normalize ${llmResult.text ? `ok chars=${llmResult.text.length}` : `FAILED (${llmResult.error})`}`,
      );

      if (llmResult.text) {
        finalText = llmResult.text;
      } else {
        logger?.log("STT", `Normalization failed, using raw input: ${llmResult.error}`, "warn");
        if (llmResult.error === "timeout") {
          toast(
            `LLM cleanup slow (>${Math.round(normalizeTimeoutMs / 1000)}s) - keeping raw text`,
            "warning",
          );
        } else {
          toast(`Normalization failed, using raw input: ${llmResult.error}`, "warning");
        }
      }
    }

    // Swap interim for final text only now that the replacement is ready:
    // restore the user's stashed text, then append the accumulated dictation
    // text plus the new final after it. When nothing was swapped (no interim,
    // no stash), the old prompt content is still in place and only the new
    // final is appended.
    const swap = await finalizeLivePrompt(logger);
    const appendText = swap.swapped ? combinePromptText(pluginPromptText, finalText) : finalText;
    try {
      await appendTranscription(client, appendText, submit);
      pluginPromptText = submit ? null : appendText;
      debugLog(
        `pipeline: final append ok chars=${appendText.length} promptBase=${pluginPromptText?.length || 0}`,
      );
      logger?.log("STT", `Pipeline completed chars=${appendText.length}`, "debug");
      toast(submit ? "Transcription submitted" : "Transcription added to prompt", "success");
    } catch (err) {
      // Final append failed after the swap: restore the raw transcription
      // rather than leaving the prompt empty. Stop tracking accumulated text
      // rather than risk resurrecting it wrongly.
      logger?.log("STT", `Final append failed: ${err.message}`, "error");
      debugLog(`pipeline: final append FAILED (${err.message}) - restoring raw text`);
      pluginPromptText = null;
      try {
        await appendTranscription(client, result.text, false);
        toast("Normalization lost - raw transcription restored", "warning");
      } catch {
        toast(`STT error: ${err.message}`, "error");
      }
    }
  } catch (err) {
    logger?.log("STT", `Pipeline error: ${err.message}`, "error");
    debugLog(`pipeline: CAUGHT ERROR ${err.message}`);
    await abandonLivePrompt(logger, true).catch(() => {});
    toast(`STT error: ${err.message}`, "error");
  } finally {
    processing = false;
    recording = false;
  }
}

// ---- Public API for TUI plugin ----

export function registerSTT(api, kv, complete, opts, logger) {
  const client = api.client;
  const systemPrompt = STT_SYSTEM_PROMPT;

  const backend = detectAudioBackend();
  logger?.log("STT", `Audio backend=${backend}`, "debug");
  function toast(message, variant = "info", duration = 3000) {
    api.ui.toast({ message, variant, duration });
  }

  pluginOpts = opts || {};

  // A manual submit clears the prompt, so accumulated dictation tracking
  // must reset when a user message lands (our own submits reset inline).
  if (typeof client.event?.subscribe === "function") {
    client.event
      .subscribe()
      .then((events) => {
        (async () => {
          for await (const event of events.stream) {
            if (event.type !== "message.updated") continue;
            const role = event.properties?.info?.role ?? event.properties?.role;
            if (role === "user") {
              debugLog("event: user message landed - resetting accumulated prompt text");
              pluginPromptText = null;
            }
          }
        })().catch(() => {});
      })
      .catch((err) => {
        logger?.log("STT", `Event subscription failed: ${err.message}`, "debug");
      });
  }

  tmpDir = opts?.tmpDir || "/tmp";
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (err) {
    logger?.log("STT", `Failed to create tmpDir ${tmpDir}: ${err.message}`, "warn");
  }
  logger?.log("STT", `STT temp dir=${tmpDir}`, "debug");

  const liveInterval = Number(opts?.liveTranscriptIntervalMs) || LIVE_INTERVAL_MS;
  liveHooks = {
    client,
    toast: (message) => api.ui.toast({ message, duration: liveInterval + 400 }),
    enabled: () => pluginOpts.liveTranscript !== false,
    target: opts?.liveTranscriptTarget === "prompt" ? "prompt" : "toast",
    interval: liveInterval,
  };
  logger?.log(
    "STT",
    `Live transcript target=${liveHooks.target} interval=${liveInterval}ms`,
    "debug",
  );
  debugLog(
    `init: configuredTarget=${liveHooks.target} clearPromptAvailable=${typeof client.tui.clearPrompt === "function"} executeCommandAvailable=${typeof client.tui.executeCommand === "function"} enabled=${pluginOpts.liveTranscript !== false}`,
  );

  // Claude Code-style listening indicator: an animated "Listening..." toast
  // for the whole recording. Toasts replace each other, so the animation
  // cycles frames; every stop path emits its own toast which replaces the
  // last frame, and the loop also self-stops once recording ends.
  let listeningAnimTimer = null;
  let listeningAnimFrame = 0;
  function stopListeningIndicator() {
    if (listeningAnimTimer) {
      clearInterval(listeningAnimTimer);
      listeningAnimTimer = null;
    }
  }
  function startListeningIndicator() {
    // In toast mode the live transcript toasts themselves are the indicator.
    if (liveHooks.enabled() && liveTarget() === "toast") return;
    stopListeningIndicator();
    const frames = ["Listening", "Listening.", "Listening..", "Listening..."];
    const show = () => {
      if (!recording || processing) {
        stopListeningIndicator();
        return;
      }
      api.ui.toast({ message: frames[listeningAnimFrame++ % frames.length], duration: 1500 });
    };
    show();
    listeningAnimTimer = setInterval(show, 600);
  }
  liveHooks.startIndicator = startListeningIndicator;
  liveHooks.stopIndicator = stopListeningIndicator;

  // ---- Voice input modes (/voice): hold (push-to-talk) or tap ----

  const talkKey = opts?.voiceKey || "ctrl+r";
  // Auto-submit is off by default; the tui.json option seeds it and /voice
  // toggles it at runtime.
  function autoSubmitEnabled() {
    return kv.get("voice.autosubmit", pluginOpts.autoSubmit === true) === true;
  }

  function getVoiceMode() {
    const fallback =
      pluginOpts.voiceMode === "hold" || pluginOpts.voiceMode === "tap"
        ? pluginOpts.voiceMode
        : "hold";
    const mode = kv.get("voice.mode", fallback);
    return mode === "hold" || mode === "tap" ? mode : fallback;
  }

  let detector = null;
  function getDetector() {
    if (!detector) {
      detector = createHoldDetector({
        onHoldStart() {
          if (processing || recording) return;
          startRecording(kv, backend, toast, logger, opts?.trimSilence);
          if (recording) startListeningIndicator();
        },
        onHoldEnd() {
          if (!recording || processing) return;
          doTranscribePipeline(
            kv,
            complete,
            client,
            toast,
            systemPrompt,
            autoSubmitEnabled(),
            logger,
          );
        },
        onTap() {
          toast(`Keep holding ${talkKey} to record, or use /voice tap mode`);
        },
      });
    }
    return detector;
  }

  function handleTalkPress() {
    if (processing) {
      toast("STT busy, please wait...");
      return;
    }
    if (getVoiceMode() === "tap") {
      if (recording) {
        doTranscribePipeline(
          kv,
          complete,
          client,
          toast,
          systemPrompt,
          autoSubmitEnabled(),
          logger,
        );
      } else {
        startRecording(kv, backend, toast, logger, opts?.trimSilence);
        if (recording) startListeningIndicator();
      }
      return;
    }
    getDetector().press();
  }

  // silent: the setup wizard announces completion itself, so it suppresses the
  // per-change toast that would otherwise immediately replace that message.
  function setVoiceMode(mode, { silent = false } = {}) {
    kv.set("voice.mode", mode);
    getDetector().reset();
    if (silent) return;
    if (mode === "tap") {
      toast(`Input mode: tap to toggle · tap ${talkKey} to start, tap again to stop`);
    } else {
      toast(`Input mode: push to talk · hold ${talkKey}, live text appears as you speak`);
    }
  }

  // Shared row layout: widens the dialog past the 60-column default and clips
  // each row so titles, values, and metrics stay on one line.
  const menu = createMenu(api);

  // One wizard instance for the whole session: it owns the background install
  // state, so re-creating it per /voice press would lose a running install.
  const setup = createVoiceSetup({
    api,
    kv,
    client,
    // The TUI's own resolved config and provider list: readable in-process on
    // builds whose /config routes answer 404.
    state: api.state,
    logger,
    opts,
    backend,
    toast,
    talkKey,
    setVoiceMode,
  });

  // ---- Shared pickers ----
  //
  // Used both by the /stt-* shortcuts (which close on pick) and by the /voice
  // hub (which passes next=showVoiceMenu to return to the settings list).

  function showModelDialog({ next } = {}) {
    menu({
      title: "Transcription model · nemo-speech",
      current: getNemoModel(kv),
      options: Object.entries(NEMO_MODELS).map(([key, v]) => ({
        title: v.short,
        description: v.detail,
        value: key,
        onSelect() {
          kv.set("stt.nemo.model", key);
          if (next) {
            next();
            return;
          }
          toast(`Transcription model: ${v.short}`);
          api.ui.dialog.clear();
        },
      })),
    });
  }

  function showMicDialog({ next } = {}) {
    const devices = listInputDevices(backend);
    if (devices.length === 0) {
      const serverOk = backend !== "pulseaudio" || pulseServerHealth().ok;
      const hint = buildAudioHint({ backend, serverOk, isWsl: isWSL() });
      logger?.log("STT", `No input devices: ${hint}`, "warn");
      toast(hint);
      return;
    }
    const pick = (name, label) => {
      kv.set("stt.mic", name);
      // sox needs the device id, but the hub should show the readable name,
      // so both are kept - deriving one from the other is not reversible.
      kv.set("stt.mic.label", label);
      if (next) {
        next();
        return;
      }
      toast(`Microphone: ${label}`);
      api.ui.dialog.clear();
    };
    // Descriptions are still long ("Brio 100 Mono"-class names run to 40+
    // columns on docks and interfaces), so this picker takes the widest
    // dialog, and the search box earns its line once the list gets long.
    menu({
      title: `Microphone · ${devices.length} available`,
      size: "xlarge",
      filter: devices.length > 8,
      placeholder: "Search inputs…",
      current: kv.get("stt.mic", ""),
      options: [
        {
          title: "System default",
          description: "follow the OS input setting",
          value: "",
          onSelect() {
            pick("", "system default");
          },
        },
        ...devices.map((d) => ({
          title: d.label,
          value: d.name,
          onSelect() {
            pick(d.name, d.label);
          },
        })),
      ],
    });
  }

  // ---- /voice settings hub ----
  //
  // A single screen listing every runtime setting with its current value.
  // Toggles flip in place and re-render (the row itself is the feedback);
  // pickers open and come back here.

  function cleanupSummary() {
    if (opts?.endpoint) {
      return `${shortLabel(opts.model || opts.endpoint)} · pinned in tui.json`;
    }
    const mode = kv.get("cleanup.mode");
    if (mode === "skip") return "off · raw dictation";
    if (mode !== "opencode") return "not configured";
    const model = kv.get("cleanup.model");
    return model ? shortLabel(model) : "your opencode default model";
  }

  function showVoiceMenu() {
    const mode = getVoiceMode();
    const options = [
      {
        title: "Input mode",
        description:
          mode === "tap"
            ? `tap to toggle · tap ${talkKey} to start and stop`
            : `push to talk · hold ${talkKey}`,
        value: "mode",
        onSelect() {
          setVoiceMode(mode === "hold" ? "tap" : "hold", { silent: true });
          showVoiceMenu();
        },
      },
      {
        title: "Auto-submit",
        description: autoSubmitEnabled()
          ? "on · sends as soon as dictation ends"
          : "off · text lands in the prompt for review",
        value: "autosubmit",
        onSelect() {
          kv.set("voice.autosubmit", !autoSubmitEnabled());
          showVoiceMenu();
        },
      },
      {
        title: "Text cleanup",
        description: cleanupSummary(),
        value: "cleanup",
        onSelect() {
          if (opts?.endpoint) {
            toast("Cleanup endpoint is pinned in tui.json");
            return;
          }
          setup.chooseCleanup({ title: "Clean up dictation with", next: showVoiceMenu });
        },
      },
      {
        title: "Transcription model",
        description: NEMO_MODELS[getNemoModel(kv)]?.short ?? "default",
        value: "model",
        onSelect() {
          showModelDialog({ next: showVoiceMenu });
        },
      },
      {
        title: "Microphone",
        // Fall back to the id for mics picked before labels were stored.
        description:
          kv.get("stt.mic.label", "") || shortDeviceId(kv.get("stt.mic", "")) || "system default",
        value: "mic",
        onSelect() {
          showMicDialog({ next: showVoiceMenu });
        },
      },
      {
        title: "Auto-gain",
        description: autoGainEnabled(kv) ? "on · boosts quiet input" : "off",
        value: "gain",
        onSelect() {
          kv.set("stt.autogain", !autoGainEnabled(kv));
          showVoiceMenu();
        },
      },
      {
        title: "Run setup again",
        value: "setup",
        onSelect() {
          setup.run();
        },
      },
    ];
    menu({ title: "Voice settings", options });
  }

  return [
    {
      title: "STT: record/transcribe",
      value: "stt.record",
      description:
        "Toggle recording; press again to stop and transcribe. /voice changes hold/tap modes",
      keybind: talkKey,
      slash: { name: "stt-record" },
      onSelect() {
        handleTalkPress();
      },
    },
    {
      title: "Voice: settings & setup",
      value: "voice.mode",
      description: `Input mode, cleanup, model, mic (${talkKey})`,
      slash: { name: "voice" },
      onSelect() {
        // First run, or an install still in flight, goes to the wizard; it
        // shows live install status instead of a half-configured settings list.
        if (!kv.get("voice.setupDone") || setup.installRunning()) {
          setup.run();
          return;
        }
        showVoiceMenu();
      },
    },
    {
      title: "STT: submit recording",
      value: "stt.submit",
      description: "Stop recording, transcribe, and submit prompt",
      slash: { name: "stt-submit" },
      onSelect() {
        if (processing) {
          toast("STT busy, please wait...");
          return;
        }
        if (!recording) {
          toast("No recording in progress", "warning");
          return;
        }
        doTranscribePipeline(kv, complete, client, toast, systemPrompt, true, logger);
      },
    },
    {
      title: "STT: cancel recording",
      value: "stt.stop",
      description: "Cancel current recording",
      slash: { name: "stt-stop" },
      onSelect() {
        getDetector().reset();
        liveHooks?.stopIndicator?.();
        stopLiveTranscript();
        abandonLivePrompt(logger, false).catch(() => {});
        if (recording) {
          recording = false;
          forceKillSox(logger);
          logger?.log("STT", "Recording cancelled", "debug");
          toast("Recording cancelled");
        }
      },
    },
    {
      title: "STT: select model",
      value: "stt.model",
      description: "Choose transcription model for nemo-speech",
      slash: { name: "stt-model" },
      onSelect() {
        showModelDialog();
      },
    },
    {
      title: "STT: auto-gain",
      value: "stt.gain",
      description: "Toggle auto-gain for quiet input",
      slash: { name: "stt-gain" },
      onSelect() {
        const autoGain = autoGainEnabled(kv);
        kv.set("stt.autogain", !autoGain);
        toast(`Auto-gain ${!autoGain ? "enabled" : "disabled"}`);
      },
    },
    {
      title: "STT: select microphone",
      value: "stt.mic",
      description: "Choose audio input device",
      slash: { name: "stt-mic" },
      onSelect() {
        showMicDialog();
      },
    },
  ];
}
