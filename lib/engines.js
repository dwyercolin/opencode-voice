// STT engine: nemo-speech (NVIDIA Parakeet/Nemotron models via NeMo-Speech.cpp).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

// Short names resolved by the nemo-speech CLI (see its models/index.json).
// Parakeet TDT is the accuracy pick for English one-shot dictation; Nemotron
// 3.5 is the multilingual CLI default. First use downloads the pinned GGUF.
// `short` is the row title (also shown inline as the active model); `detail`
// is the muted column beside it in the picker.
export const NEMO_MODELS = {
  "": { short: "Nemotron 3.5", detail: "multilingual, nemo-speech default" },
  "parakeet-tdt": { short: "Parakeet TDT", detail: "0.6B v3, English, best accuracy" },
  "nemotron-en": { short: "Nemotron EN", detail: "English, streaming" },
  "parakeet-ctc": { short: "Parakeet CTC", detail: "1.1B, English" },
};

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

export function buildNemoArgs(wavFile, model = "") {
  const args = ["--quiet", "transcribe", wavFile];
  if (model) args.push("--model", model);
  return args;
}

export function transcribeNemo({ wavFile, model = "", logger }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const args = buildNemoArgs(wavFile, model);
    const proc = spawn(binaryCommand("nemo-speech"), args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    logger?.log("STT", `Started nemo-speech pid=${proc.pid} model=${model || "default"}`, "debug");

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    // First run of a model downloads its pinned GGUF (~700 MB), so allow a
    // longer budget than a typical local transcription.
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      logger?.log("STT", "nemo-speech timed out after 180s", "error");
      resolve({ error: "Transcription timed out (180s - first run may download the model)" });
    }, 180000);

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
