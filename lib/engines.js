// STT engines: nemo-speech (Parakeet/Nemotron, default), whisper.cpp
// (with Silero VAD), and OpenAI-compatible transcription APIs (for machines
// that cannot run local models, or languages the local models cover poorly).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";

export const WHISPER_MODELS_DIRS = [
  path.join(os.homedir(), ".local", "share", "whisper-cpp"),
  "/opt/homebrew/share/whisper-cpp/models",
  "/usr/local/share/whisper-cpp/models",
];

export const WHISPER_MODELS = {
  "large-v3-turbo-q5_0": {
    label: "Large v3 Turbo Q5",
    size: "574 MB",
    file: "ggml-large-v3-turbo-q5_0.bin",
  },
  "large-v3-turbo-q8_0": {
    label: "Large v3 Turbo Q8",
    size: "834 MB",
    file: "ggml-large-v3-turbo-q8_0.bin",
  },
  "large-v3-turbo": {
    label: "Large v3 Turbo (full)",
    size: "1.6 GB",
    file: "ggml-large-v3-turbo.bin",
  },
  "medium-q5_0": {
    label: "Medium Q5",
    size: "514 MB",
    file: "ggml-medium-q5_0.bin",
  },
  "small.en": { label: "Small English", size: "466 MB", file: "ggml-small.en.bin" },
  small: { label: "Small Multilingual", size: "466 MB", file: "ggml-small.bin" },
  "base.en": { label: "Base English", size: "142 MB", file: "ggml-base.en.bin" },
  base: { label: "Base Multilingual", size: "142 MB", file: "ggml-base.bin" },
  "tiny.en": { label: "Tiny English", size: "75 MB", file: "ggml-tiny.en.bin" },
  tiny: { label: "Tiny Multilingual", size: "75 MB", file: "ggml-tiny.bin" },
};
export const DEFAULT_WHISPER_MODEL = "large-v3-turbo-q5_0";

// Short names resolved by the nemo-speech CLI (see its models/index.json).
// Parakeet TDT is the accuracy pick for English one-shot dictation; Nemotron
// 3.5 is the multilingual CLI default. First use downloads the pinned GGUF.
export const NEMO_MODELS = {
  "": { label: "Default (Nemotron 3.5 - multilingual)" },
  "parakeet-tdt": { label: "Parakeet TDT 0.6B v3 (English, best accuracy)" },
  "nemotron-en": { label: "Nemotron English streaming" },
  "parakeet-ctc": { label: "Parakeet CTC 1.1B (English)" },
};

// Preferred first: v6.2.0 is the version showcased by whisper.cpp's README.
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

// ---- whisper.cpp ----

export function buildWhisperArgs(modelPath, wavFile, language, vadModel = null) {
  const args = ["-m", modelPath, "-f", wavFile, "-l", language || "auto", "-np", "-nt"];
  if (vadModel) args.push("--vad", "--vad-model", vadModel);
  return args;
}

function runWhisperCli(args, logger) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn("whisper-cli", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    logger?.log("STT", `Started whisper-cli pid=${proc.pid}`, "debug");

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      logger?.log("STT", "whisper-cli timed out after 60s", "error");
      resolve({ error: "Transcription timed out (60s)" });
    }, 60000);

    proc.on("error", (err) => {
      clearTimeout(timer);
      logger?.log("STT", `whisper-cli error: ${err.message}`, "error");
      resolve({ error: `Transcription failed: ${err.message}` });
    });

    proc.on("exit", (code) => {
      clearTimeout(timer);
      // whisper-cli exits 0 even for an unknown language, printing the error to
      // stderr instead; surface it rather than reporting "no speech detected".
      const langError = stderr.match(/error: unknown language '([^']+)'/);
      if (langError) {
        logger?.log("STT", `whisper-cli rejected language: ${langError[1]}`, "error");
        resolve({ error: `Unknown whisper language: ${langError[1]}` });
        return;
      }
      if (code !== 0) {
        logger?.log("STT", `whisper-cli exited code=${code} stderr=${stderr.trim()}`, "error");
        resolve({ error: stderr.trim().split("\n").pop() || `whisper-cli exited (code=${code})` });
        return;
      }
      logger?.log("STT", `Local transcription succeeded stdoutChars=${stdout.length}`, "debug");
      resolve({
        text: stdout
          .replace(/\[.*?\]/g, "")
          .replace(/\(.*?\)/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      });
    });
  });
}

export async function transcribeWhisper({ modelPath, wavFile, language, vadModel, logger }) {
  logger?.log(
    "STT",
    `Local transcription requested model=${modelPath} language=${language}`,
    "debug",
  );
  if (!fs.existsSync(modelPath)) {
    logger?.log("STT", `Whisper model missing: ${modelPath}`, "error");
    return {
      error: `Model not found: ${modelPath}. Download from huggingface.co/ggerganov/whisper.cpp`,
    };
  }
  if (vadModel) {
    logger?.log("STT", `Using Silero VAD model: ${vadModel}`, "debug");
  } else {
    logger?.log(
      "STT",
      "No Silero VAD model found (ggml-silero-*.bin) - silence may produce hallucinated text; see README",
      "warn",
    );
  }

  const result = await runWhisperCli(
    buildWhisperArgs(modelPath, wavFile, language, vadModel),
    logger,
  );

  // Older whisper-cli builds predate the --vad flag; retry once without VAD
  // rather than failing the whole transcription.
  if (result.error && vadModel && /--vad|unknown argument/i.test(result.error)) {
    logger?.log(
      "STT",
      `whisper-cli rejected VAD flags, retrying without VAD: ${result.error}`,
      "warn",
    );
    const retried = await runWhisperCli(
      buildWhisperArgs(modelPath, wavFile, language, null),
      logger,
    );
    return { ...retried, vadFallback: true };
  }
  return result;
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
    // longer budget than local whisper transcription.
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

// ---- OpenAI-compatible transcription API ----

export function isOpenRouterEndpoint(endpoint) {
  return /(^https?:\/\/)?([^/]+\.)?openrouter\.ai(\/|$)/i.test(endpoint || "");
}

export function buildMultipartTranscriptionRequest(model, audioBuffer, apiKey) {
  const blob = new Blob([audioBuffer], { type: "audio/wav" });
  const form = new FormData();
  form.append("file", blob, "audio.wav");
  form.append("model", model);
  form.append("response_format", "json");

  const headers = {};
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  return {
    headers,
    body: form,
  };
}

export function buildOpenRouterTranscriptionRequest(model, audioBuffer, apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = "Bearer " + apiKey;

  const payload = {
    model,
    input_audio: {
      data: audioBuffer.toString("base64"),
      format: "wav",
    },
  };

  return {
    headers,
    body: JSON.stringify(payload),
  };
}

export async function transcribeApi({ endpoint, model, apiKeyEnv, wavFile, logger }) {
  if (!endpoint || !model) {
    logger?.log("STT", "STT API transcription skipped: API not configured", "warn");
    return { error: "STT API not configured" };
  }

  try {
    const audioBuffer = await fs.promises.readFile(wavFile);
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : null;
    const useOpenRouterFormat = isOpenRouterEndpoint(endpoint);

    const url = endpoint.endsWith("/")
      ? `${endpoint}audio/transcriptions`
      : `${endpoint}/audio/transcriptions`;

    const request = useOpenRouterFormat
      ? buildOpenRouterTranscriptionRequest(model, audioBuffer, apiKey)
      : buildMultipartTranscriptionRequest(model, audioBuffer, apiKey);

    const resp = await fetch(url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(60000),
    });
    logger?.log("STT", `STT API response status=${resp.status}`, resp.ok ? "debug" : "error");

    if (!resp.ok) {
      const responseBody = await resp.text();
      let msg = `STT API error ${resp.status}`;
      try {
        const err = JSON.parse(responseBody);
        msg = err?.error?.message || msg;
      } catch {}
      return { error: msg };
    }

    let data;
    try {
      data = await resp.json();
    } catch (err) {
      logger?.log("STT", `STT API returned invalid JSON: ${err.message}`, "error");
      return { error: `STT API returned invalid JSON: ${err.message}` };
    }
    logger?.log("STT", `STT API transcription succeeded chars=${data.text?.length || 0}`, "debug");
    return { text: data.text?.trim() || "" };
  } catch (err) {
    logger?.log("STT", `STT API request failed: ${err.message}`, "error");
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return { error: "STT API request timed out (60s)" };
    }
    return { error: `STT API request failed: ${err.message}` };
  }
}
