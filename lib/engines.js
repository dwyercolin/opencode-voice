// STT engine: nemo-speech (NVIDIA Parakeet/Nemotron models via NeMo-Speech.cpp).

import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";

// Short names resolved by the nemo-speech CLI (see its models/index.json).
// Parakeet TDT is the accuracy pick for English one-shot dictation; Nemotron
// 3.5 is the multilingual CLI default. First use downloads the pinned GGUF.
export const NEMO_MODELS = {
  "": { label: "Default (Nemotron 3.5 - multilingual)" },
  "parakeet-tdt": { label: "Parakeet TDT 0.6B v3 (English, best accuracy)" },
  "nemotron-en": { label: "Nemotron English streaming" },
  "parakeet-ctc": { label: "Parakeet CTC 1.1B (English)" },
};

const VAD_MODELS = ["ggml-silero-v6.2.0.bin", "ggml-silero-v5.1.2.bin"];

export function findVadModel(dirs = WHISPER_MODELS_DIRS) {
  for (const file of VAD_MODELS) {
    for (const dir of dirs) {
      const candidate = path.join(dir, file);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const binaryCache = new Map();

export function hasBinary(name) {
  if (binaryCache.has(name)) return binaryCache.get(name);
  let found = false;
  for (const flag of ["--version", "--help"]) {
    try {
      execSync(`${name} ${flag}`, { stdio: "ignore", timeout: 5000 });
      found = true;
      break;
    } catch {}
  }
  binaryCache.set(name, found);
  return found;
}

// Forget cached binary lookups (e.g. after the setup wizard installs one).
export function invalidateBinaryCache() {
  binaryCache.clear();
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
    const proc = spawn("nemo-speech", args, {
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
