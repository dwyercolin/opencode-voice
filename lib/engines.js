// STT engine: nemo-speech (NVIDIA Parakeet/Nemotron models via NeMo-Speech.cpp).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

import { STT_LANGUAGE_AUTO, normalizeSttLanguage } from "./stt-languages.js";

// Short names resolved by the nemo-speech CLI (see its models/index.json).
// Parakeet TDT is the English/Spanish accuracy pick; Nemotron 3.5 is the
// multilingual CLI default. Each model is its own ~700 MB-1.1 GB
// download, cached separately - switching models is a fresh download.
// `short` is the row title (also shown inline as the active model); `detail`
// is the muted column beside it in the picker; `repo` is the Hugging Face id
// the CLI caches under, which is how a model's own download is located
// (`nemo-speech model list --json` is the source of these).
//
// Every key is a real CLI alias, INCLUDING the multilingual default. It used
// to be keyed "" (meaning "pass no --model, let the CLI pick"), which also
// reads as "nothing configured yet" - and the two readings disagreed: the
// wizard's screen resolved "" with ?? (a real choice: Nemotron) while its
// gate resolved it with || (unset: Parakeet), so downloading the model the
// screen offered still left the gate demanding a second one.
export const NEMO_MODELS = {
  "nemotron-3.5": {
    short: "Nemotron 3.5",
    detail: "multilingual, nemo-speech default",
    repo: "nvidia/nemotron-3.5-asr-streaming-0.6b",
  },
  "parakeet-tdt": {
    short: "Parakeet TDT",
    detail: "0.6B v3, English and Spanish",
    repo: "nvidia/parakeet-tdt-0.6b-v3",
  },
  "nemotron-en": {
    short: "Nemotron EN",
    detail: "English, streaming",
    repo: "nvidia/nemotron-speech-streaming-en-0.6b",
  },
  "parakeet-ctc": {
    short: "Parakeet CTC",
    detail: "1.1B, English",
    repo: "nvidia/parakeet-ctc-1.1b",
  },
};

// Seeded for new users: Parakeet TDT is the fast English/Spanish default.
// /stt-model switches to the multilingual one.
export const DEFAULT_NEMO_MODEL = "parakeet-tdt";

// What "" meant before every model got its own key: the CLI's multilingual
// default. Settings written by older versions still hold it.
const LEGACY_DEFAULT_NEMO_MODEL = "nemotron-3.5";

/**
 * The model a stored setting actually names. THE single place "unset" and
 * "the multilingual default" are told apart - every caller reading
 * `stt.nemo.model` goes through here, because a second spelling of this
 * decision is exactly what asked for two downloads in one setup.
 */
export function normalizeNemoModel(stored) {
  if (stored === "") return LEGACY_DEFAULT_NEMO_MODEL;
  if (!stored) return DEFAULT_NEMO_MODEL;
  return String(stored);
}

const binaryCache = new Map();

// The wizard's installer puts nemo-speech in ~/.local/bin, which is not
// guaranteed to be on the TUI process's PATH - the install shell gets it
// prepended explicitly for exactly that reason. Resolve binaries through
// that directory when they exist there, so a completed install works without
// a restart, both in the hasBinary probe and in the actual spawn.
export function binaryCommand(name) {
  const local = path.join(os.homedir(), ".local", "bin", name);
  try {
    if (fs.existsSync(local)) return local;
  } catch {}
  return name;
}

// "Installed?" means a file with the executable bit on PATH (or in
// ~/.local/bin), not "runs with --version": tools disagree on flags - xclip
// treats --version as a filename and exits 1 - so executing the binary to
// probe it reported working installs as missing.
export function hasBinary(name) {
  if (binaryCache.has(name)) return binaryCache.get(name);
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const candidates = [path.join(os.homedir(), ".local", "bin", name)];
  for (const dir of dirs) candidates.push(path.join(dir, name));
  let found = false;
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        found = true;
        break;
      }
    } catch {}
  }
  binaryCache.set(name, found);
  return found;
}

// Forget cached binary lookups (e.g. after the setup wizard installs one).
export function invalidateBinaryCache() {
  binaryCache.clear();
}

// Recording needs sox, which - unlike nemo-speech - comes from the system
// package manager and needs root, so the plugin cannot install it for the
// user. The wizard and the recording failure path both show this command
// instead, rather than leaving a bare "spawn sox ENOENT" as the only clue.
// On Debian/Ubuntu the PulseAudio driver and pactl are separate packages and
// recording fails without them, so all three are named.
export function soxInstallCommand(platform = process.platform) {
  if (platform === "darwin") return "brew install sox";
  return "sudo apt install sox libsox-fmt-pulse pulseaudio-utils";
}

// Copy an in-progress WAV recording to dst, patching RIFF/data sizes so the
// snapshot is a valid, decodable file while sox is still writing the source.
// Returns true on success, false when there is no usable audio yet.
export function snapshotPartialWav(src, dst) {
  let buf;
  try {
    buf = fs.readFileSync(src);
  } catch {
    return false;
  }
  if (buf.length <= 44 || buf.toString("ascii", 0, 4) !== "RIFF") return false;

  // Walk chunks to locate "data" (sox may emit fmt extras before it).
  let off = 12;
  let dataOff = -1;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      dataOff = off;
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0) return false;

  const dataSize = buf.length - dataOff - 8;
  if (dataSize <= 0) return false;
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.writeUInt32LE(dataSize, dataOff + 4);
  try {
    fs.writeFileSync(dst, buf);
    return true;
  } catch {
    return false;
  }
}

// Slice the data chunk of a WAV file from a file-relative byte offset (the
// header is copied verbatim so fmt extras survive, and RIFF/data sizes are
// patched). startFileByte is expressed in whole-file bytes (header included),
// matching sizes captured from prior snapshots of the same recording. Returns
// the number of data bytes written, or -1 on failure / nothing to slice.
export function sliceWavFrom(src, dst, startFileByte) {
  let buf;
  try {
    buf = fs.readFileSync(src);
  } catch {
    return -1;
  }
  if (buf.length <= 44 || buf.toString("ascii", 0, 4) !== "RIFF") return -1;

  let off = 12;
  let dataOff = -1;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      dataOff = off;
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (dataOff < 0) return -1;

  const dataStart = dataOff + 8;
  const dataSize = buf.length - dataStart;
  const startData = Math.max(0, Math.min(startFileByte - dataStart, dataSize));
  const sliced = buf.length - dataStart - startData;
  if (sliced <= 0) return -1;

  const out = Buffer.concat([buf.subarray(0, dataStart), buf.subarray(dataStart + startData)]);
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(sliced, dataOff + 4);
  try {
    fs.writeFileSync(dst, out);
    return sliced;
  } catch {
    return -1;
  }
}

// ---- nemo-speech (NVIDIA NeMo-Speech.cpp) ----

export function buildNemoArgs(wavFile, model = "", language = STT_LANGUAGE_AUTO) {
  const args = ["--quiet", "transcribe", wavFile];
  if (model) args.push("--model", model);
  const selectedLanguage = normalizeSttLanguage(language);
  if (selectedLanguage !== STT_LANGUAGE_AUTO) args.push("--language", selectedLanguage);
  return args;
}

// The model cache the CLI maintains: models/<org>/<name>/<hash>/<file>.gguf,
// with a sibling <file>.gguf.verified marker once the download has passed its
// SHA-256 check, and a <file>.gguf.partial while it is still coming down.
// Layout is the CLI's own; only the marker suffixes are relied on.
export const NEMO_CACHE_DIR = path.join(os.homedir(), ".cache", "nemo-speech", "models");

/**
 * Hugging Face repo id the CLI downloads and caches for a model name. Both
 * the short alias and the repo id are accepted "wherever MODEL is accepted",
 * and the repo id is what the pull command gets - a `pull` needs a name, so
 * the multilingual default cannot be spelled as "pass no --model".
 *
 * `""` is still understood, since settings written before every model got its
 * own key hold it: it names the CLI's multilingual default.
 */
export function nemoModelRepo(model = "") {
  const name = model === "" ? LEGACY_DEFAULT_NEMO_MODEL : model;
  return NEMO_MODELS[name]?.repo ?? (String(name).includes("/") ? String(name) : "");
}

/** Cache directory for one model, or null for a name with no known repo. */
export function nemoModelDir(model = "", cacheDir = NEMO_CACHE_DIR) {
  const repo = nemoModelRepo(model);
  return repo ? path.join(cacheDir, ...repo.split("/")) : null;
}

/**
 * What the cache holds for ONE model:
 *
 * - `ready`   - verified, transcription starts immediately
 * - `partial` - a download was started and did not finish. NOT "downloading
 *   now": a killed or failed pull leaves the same `.partial` behind (and the
 *   `.lock` file survives even a *successful* download, so neither file can
 *   stand for in-flight). Only the plugin's own job registry knows what is
 *   live right now.
 * - `missing` - nothing downloaded
 *
 * Per-model, because each one is its own download: "some model is cached" is
 * what made a model switch look ready and then stall inside a dictation.
 * `bytes` is the largest partial found, for progress against the total size.
 */
export function nemoModelState(model = "", cacheDir = NEMO_CACHE_DIR) {
  const dir = nemoModelDir(model, cacheDir);
  if (!dir) return { status: "unknown", bytes: 0 };
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { recursive: true });
  } catch {
    return { status: "missing", bytes: 0 };
  }
  const names = entries.map((entry) => String(entry));
  if (names.some((name) => name.endsWith(".gguf.verified"))) return { status: "ready", bytes: 0 };
  let bytes = 0;
  let partial = false;
  for (const name of names) {
    if (!name.endsWith(".partial")) continue;
    partial = true;
    try {
      bytes = Math.max(bytes, fs.statSync(path.join(dir, name)).size);
    } catch {}
  }
  return { status: partial ? "partial" : "missing", bytes };
}

/** Whether this specific model is downloaded and verified. */
export function hasVerifiedNemoModel(model = "", cacheDir = NEMO_CACHE_DIR) {
  return nemoModelState(model, cacheDir).status === "ready";
}

/** Transcription budget: generous when the model still has to come down inside the call. */
export function transcribeTimeoutMs(hasVerified = true) {
  return hasVerified ? 180000 : 30 * 60000;
}

// The CLI announces the download and its total size on stderr before curl
// starts, e.g.
//   [model] downloading nvidia/parakeet-ctc-1.1b@20e63a0f (asr, 1123.5 MiB)
// This is the ONLY progress signal that survives a pipe: the percentages come
// from curl's own meter, which curl draws only when stderr is a TTY. Under
// the plugin's pipe that meter never appears, so the total from this line
// plus the growing `.partial` on disk is what makes a real percentage.
const NEMO_TOTAL_RE = /\((?:[a-z]+,\s*)?([\d.]+)\s*(KiB|MiB|GiB)\)/i;
const UNIT_BYTES = { kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 };

/** Total download size announced by `nemo-speech pull`, in bytes (0 if not seen yet). */
export function parseNemoDownloadTotal(text) {
  const match = NEMO_TOTAL_RE.exec(String(text ?? ""));
  if (!match) return 0;
  const size = Number.parseFloat(match[1]);
  if (!Number.isFinite(size)) return 0;
  return Math.round(size * UNIT_BYTES[match[2].toLowerCase()]);
}

export function transcribeNemo({ wavFile, model = "", language = STT_LANGUAGE_AUTO, logger }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const args = buildNemoArgs(wavFile, model, language);
    const proc = spawn(binaryCommand("nemo-speech"), args, {
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so the timeout kill below reaches the CLI's
      // download children (curl) instead of orphaning them mid-download.
      detached: true,
    });
    logger?.log("STT", `Started nemo-speech pid=${proc.pid} model=${model || "default"}`, "debug");

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    // A model that is not cached downloads inside this very call, so the
    // budget is per-model: asking "is ANY model verified?" kept the 3-minute
    // budget after a model switch and killed the transcription mid-download.
    // A normal local transcription finishes well inside 3 minutes.
    const timeoutMs = transcribeTimeoutMs(hasVerifiedNemoModel(model));
    const timer = setTimeout(() => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
      logger?.log("STT", `nemo-speech timed out after ${timeoutMs / 1000}s`, "error");
      resolve({
        error: `Transcription timed out (${timeoutMs / 1000}s) - run /voice to check the model download`,
      });
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      logger?.log("STT", `nemo-speech error: ${err.message}`, "error");
      resolve({
        error: `nemo-speech not found. Install: curl -fsSL https://github.com/NVIDIA/NeMo-Speech.cpp/raw/main/scripts/install.sh | sh`,
      });
    });

    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        logger?.log("STT", `nemo-speech exited code=${code} stderr=${stderr.trim()}`, "error");
        resolve({ error: stderr.trim().split("\n").pop() || `nemo-speech exited (code=${code})` });
        return;
      }
      logger?.log(
        "STT",
        `nemo-speech transcription succeeded stdoutChars=${stdout.length}`,
        "debug",
      );
      resolve({ text: stdout.replace(/\s+/g, " ").trim() });
    });
  });
}
