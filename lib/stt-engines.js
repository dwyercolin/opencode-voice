// Engine-neutral STT model catalog, configuration, and backend dispatch.
// Individual runtimes stay in their own adapter so stt.js does not need to
// know how a model is installed or how audio reaches it.

import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  NEMO_MODELS,
  hasBinary,
  hasVerifiedNemoModel,
  nemoModelState,
  normalizeNemoModel,
  transcribeNemo,
} from "./engines.js";
import { funAsrLlamaPaths, FUNASR_LLAMA_CPP_ENDPOINT } from "./stt-runtime-paths.js";
import { STT_BACKENDS } from "./stt-types.js";
import {
  managedSttEndpoint,
  managedSttModelCached,
  managedSttRuntime,
  managedSttRuntimeInstalled,
} from "./stt-runtimes.js";
import {
  STT_LANGUAGE_AUTO,
  modelSupportsSttLanguage,
  normalizeSttLanguage,
  sttLanguageLabel,
} from "./stt-languages.js";

export { STT_BACKENDS } from "./stt-types.js";

const OPENAI_COMPATIBLE_MODELS = {
  "remote:qwen3-asr-0.6b": {
    backend: STT_BACKENDS.OPENAI_COMPATIBLE,
    model: "Qwen/Qwen3-ASR-0.6B",
    short: "Qwen3-ASR 0.6B",
    detail: "Chinese + multilingual · simulated live · vLLM",
    languages: ["en", "es", "zh", "ja", "ko"],
    live: "simulated",
    merge: "auto",
  },
  "remote:qwen3-asr-1.7b": {
    backend: STT_BACKENDS.OPENAI_COMPATIBLE,
    model: "Qwen/Qwen3-ASR-1.7B",
    short: "Qwen3-ASR 1.7B",
    detail: "strong multilingual · simulated live · vLLM",
    languages: ["en", "es", "zh", "ja", "ko"],
    live: "simulated",
    merge: "auto",
  },
  "remote:fun-asr-nano-2512": {
    backend: STT_BACKENDS.FUNASR_LLAMA_CPP,
    model: "FunAudioLLM/Fun-ASR-Nano-2512",
    short: "Fun-ASR Nano 2512",
    detail: "Chinese dialects + accents · official GGUF · llama.cpp",
    languages: ["zh", "en", "ja"],
    live: "simulated",
    merge: "characters",
  },
  "remote:fun-asr-mlt-nano-2512": {
    backend: STT_BACKENDS.FUNASR_HTTP,
    model: "FunAudioLLM/Fun-ASR-MLT-Nano-2512",
    requestModel: "custom",
    short: "Fun-ASR MLT Nano 2512",
    detail: "multilingual · managed local service",
    languages: ["en", "zh", "ja", "ko"],
    languageHints: { en: "英文", zh: "中文", ja: "日文", ko: "韩文" },
    live: "simulated",
    merge: "auto",
  },
};

const NEMOTRON_LANGUAGES = ["en", "es", "zh", "ja", "ko"];

const NEMO_MODEL_LANGUAGES = {
  "nemotron-3.5": NEMOTRON_LANGUAGES,
  "parakeet-tdt": ["en", "es"],
  "nemotron-en": ["en"],
  "parakeet-ctc": ["en"],
};

const NEMO_MODEL_OPTIONS = Object.fromEntries(
  Object.entries(NEMO_MODELS).map(([model, value]) => [
    `nemo:${model}`,
    {
      backend: STT_BACKENDS.NEMO,
      model,
      short: value.short,
      detail: `${value.detail} · simulated live`,
      languages: NEMO_MODEL_LANGUAGES[model] || null,
      live: "simulated",
      merge: "words",
    },
  ]),
);

// Keep the picker to the original NeMo models plus the documented Qwen/Fun-ASR
// paths. Every advertised language has explicit upstream model support.
export const STT_MODELS = Object.freeze({
  ...NEMO_MODEL_OPTIONS,
  ...OPENAI_COMPATIBLE_MODELS,
});

export const DEFAULT_STT_MODEL = "nemo:parakeet-tdt";

const OPENAI_COMPATIBLE_BACKEND_ALIASES = new Set([
  STT_BACKENDS.OPENAI_COMPATIBLE,
  "openai",
  "http",
  "vllm",
]);

const RETIRED_STT_MODELS = {
  "omnilingual:ctc-300m": {
    name: "Omnilingual CTC 300M",
    message:
      "Omnilingual CTC 300M is unavailable because it cannot enforce the selected language. Choose another transcription model in /voice.",
  },
  "canary:1b-v2": { name: "Canary 1B v2" },
  "moonshine:de-small-streaming": { name: "Moonshine German Small" },
  "whisper:large-v3-turbo-q5_0": { name: "Whisper large-v3-turbo" },
  "whisper:small": { name: "Whisper Small" },
};

const RETIRED_STT_BACKENDS = new Set([
  "omnilingual",
  "canary",
  "moonshine",
  "whisper-cpp",
  "whisper",
]);

function normalizeBackend(value) {
  const backend = String(value || STT_BACKENDS.NEMO)
    .trim()
    .toLowerCase();
  if (OPENAI_COMPATIBLE_BACKEND_ALIASES.has(backend)) {
    return STT_BACKENDS.OPENAI_COMPATIBLE;
  }
  if (
    backend === STT_BACKENDS.FUNASR_WEBSOCKET ||
    backend === "funasr" ||
    backend === "websocket"
  ) {
    return STT_BACKENDS.FUNASR_WEBSOCKET;
  }
  if (backend === STT_BACKENDS.FUNASR_HTTP) return STT_BACKENDS.FUNASR_HTTP;
  if (backend === STT_BACKENDS.FUNASR_LLAMA_CPP || backend === "funasr-llama") {
    return STT_BACKENDS.FUNASR_LLAMA_CPP;
  }
  return STT_BACKENDS.NEMO;
}

function optionForModel(backend, model) {
  return Object.entries(STT_MODELS).find(
    ([, option]) => option.backend === backend && option.model === model,
  )?.[0];
}

function endpointFrom(kv, options) {
  return String(kv?.get("stt.endpoint", options?.sttEndpoint) || "").trim();
}

function apiKeyEnvFrom(kv, options) {
  return String(kv?.get("stt.apiKeyEnv", options?.sttApiKeyEnv) || "").trim();
}

function configFromOption(id, option, endpoint, apiKeyEnv, language) {
  const runtime = managedSttRuntime(option.backend);
  return {
    id,
    backend: option.backend,
    model: option.model,
    displayName: option.short,
    detail: option.detail,
    languages: option.languages,
    language,
    live: option.live,
    merge: option.merge || "words",
    endpoint: runtime ? managedSttEndpoint(option.backend) : endpoint,
    apiKeyEnv: runtime ? "" : apiKeyEnv,
    ...(option.requestModel ? { requestModel: option.requestModel } : {}),
    ...(option.languageHints ? { languageHints: option.languageHints } : {}),
    ...(option.requiresLanguage ? { requiresLanguage: true } : {}),
  };
}

function unavailableSttConfig({ endpoint, apiKeyEnv, language, model, selected, backend }) {
  const retired = RETIRED_STT_MODELS[selected];
  const name = retired?.name || `The ${backend} STT backend`;
  return {
    id: selected || `retired:${backend}`,
    backend: "retired",
    model: model || selected || backend,
    displayName: name,
    detail: "unavailable · choose a supported model",
    languages: null,
    language,
    live: "simulated",
    merge: "words",
    endpoint,
    apiKeyEnv,
    unavailable:
      retired?.message ||
      `${name} is no longer supported. Choose another transcription model in /voice.`,
  };
}

/**
 * Resolve both the new engine-neutral settings and the shipped NeMo setting.
 * `stt.nemo.model` remains a real persisted setting because users already have
 * it in api.kv; new selections additionally write `stt.model` and
 * `stt.backend`.
 */
export function resolveSttConfig(kv, options = {}) {
  const endpoint = endpointFrom(kv, options);
  const apiKeyEnv = apiKeyEnvFrom(kv, options);
  const language = normalizeSttLanguage(kv?.get("stt.language", options.sttLanguage));
  const selected = String(kv?.get("stt.model", "") || "").trim();
  const selectedOption = STT_MODELS[selected];
  if (selectedOption) {
    return configFromOption(selected, selectedOption, endpoint, apiKeyEnv, language);
  }
  const storedBackend = String(kv?.get("stt.backend", options.sttBackend) || "")
    .trim()
    .toLowerCase();
  if (RETIRED_STT_MODELS[selected] || RETIRED_STT_BACKENDS.has(storedBackend)) {
    const model = String(kv?.get("stt.remote.model", options.sttModel) || "").trim();
    return unavailableSttConfig({
      endpoint,
      apiKeyEnv,
      language,
      model,
      selected,
      backend: storedBackend,
    });
  }
  const backend = normalizeBackend(storedBackend);

  if (
    backend === STT_BACKENDS.OPENAI_COMPATIBLE ||
    backend === STT_BACKENDS.FUNASR_HTTP ||
    backend === STT_BACKENDS.FUNASR_WEBSOCKET ||
    backend === STT_BACKENDS.FUNASR_LLAMA_CPP
  ) {
    const model = String(
      kv?.get("stt.remote.model", options.sttModel) || options.sttModel || "",
    ).trim();
    const id =
      (backend === STT_BACKENDS.FUNASR_WEBSOCKET && model === "FunAudioLLM/Fun-ASR-MLT-Nano-2512"
        ? "remote:fun-asr-mlt-nano-2512"
        : optionForModel(backend, model)) || `remote:custom:${model}`;
    const option = STT_MODELS[id];
    if (option) return configFromOption(id, option, endpoint, apiKeyEnv, language);
    const config = {
      id,
      backend,
      model,
      displayName: STT_MODELS[id]?.short || model || "OpenAI-compatible STT",
      detail:
        STT_MODELS[id]?.detail ||
        (backend === STT_BACKENDS.FUNASR_WEBSOCKET
          ? "custom Fun-ASR model · simulated live · WebSocket server"
          : backend === STT_BACKENDS.FUNASR_LLAMA_CPP
            ? "custom Fun-ASR model · official GGUF · llama.cpp"
            : "custom model · simulated live"),
      live: "simulated",
      merge: "auto",
      languages: STT_MODELS[id]?.languages || null,
      language,
      endpoint,
      apiKeyEnv,
    };
    return config;
  }

  const storedNemoModel = kv?.get("stt.nemo.model", null);
  const model = normalizeNemoModel(storedNemoModel ?? options.sttNemoModel);
  const id = optionForModel(backend, model) || `nemo:${model}`;
  const option = STT_MODELS[id];
  return option
    ? configFromOption(id, option, endpoint, apiKeyEnv, language)
    : {
        id,
        backend: STT_BACKENDS.NEMO,
        model,
        displayName: model,
        detail: "custom NeMo model · native live",
        languages: null,
        language,
        live: "native",
        merge: "words",
        endpoint,
        apiKeyEnv,
      };
}

export function sttModelOption(id) {
  return STT_MODELS[id] || null;
}

export { STT_LANGUAGE_AUTO, modelSupportsSttLanguage } from "./stt-languages.js";

export function transcriptionEndpoint(endpoint) {
  const base = String(endpoint || "")
    .trim()
    .replace(/\/+$/, "");
  if (!base) return "";
  if (/\/audio\/transcriptions$/i.test(base)) return base;
  return `${base}/audio/transcriptions`;
}

export function validTranscriptionEndpoint(endpoint) {
  try {
    const url = new URL(transcriptionEndpoint(endpoint));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function validSttEndpoint(endpoint, backend = STT_BACKENDS.OPENAI_COMPATIBLE) {
  if (backend === STT_BACKENDS.FUNASR_LLAMA_CPP) {
    return String(endpoint || "").trim() === FUNASR_LLAMA_CPP_ENDPOINT;
  }
  if (backend === STT_BACKENDS.FUNASR_WEBSOCKET) {
    try {
      const url = new URL(String(endpoint || "").trim());
      return url.protocol === "ws:" || url.protocol === "wss:";
    } catch {
      return false;
    }
  }
  return validTranscriptionEndpoint(endpoint);
}

export function sttModelStatus(config) {
  if (config?.unavailable) return "unavailable";
  if (!modelSupportsSttLanguage(config, config?.language)) return "unsupported-language";
  if (config?.backend === STT_BACKENDS.NEMO) {
    if (!hasBinary("nemo-speech")) return "backend-missing";
    return nemoModelState(config.model).status;
  }
  if (managedSttRuntime(config?.backend)) {
    if (managedSttRuntimeInstalled(config.backend, config.model)) return "ready";
    return managedSttModelCached(config.backend, config.model) ? "cached" : "model-missing";
  }
  return validSttEndpoint(config?.endpoint, config?.backend) && config?.model
    ? "configured"
    : "endpoint-required";
}

export function sttReadiness(config) {
  if (config?.unavailable) {
    return { ready: false, status: "unavailable", message: config.unavailable };
  }
  if (!config?.model) {
    return { ready: false, status: "model-required", message: "No transcription model selected" };
  }
  if (!modelSupportsSttLanguage(config, config.language)) {
    return {
      ready: false,
      status: "unsupported-language",
      message: `${config.displayName} does not list ${sttLanguageLabel(config.language)} support`,
    };
  }
  if (config.backend === STT_BACKENDS.NEMO) {
    if (!hasBinary("nemo-speech")) {
      return {
        ready: false,
        status: "backend-missing",
        message: "nemo-speech is not installed - run /voice setup",
      };
    }
    if (!hasVerifiedNemoModel(config.model)) {
      return {
        ready: false,
        status: "model-missing",
        message: `${config.displayName} is not downloaded - run /voice setup`,
      };
    }
    return { ready: true, status: "ready" };
  }
  if (managedSttRuntime(config.backend) && config.endpoint === managedSttEndpoint(config.backend)) {
    if (!managedSttRuntimeInstalled(config.backend, config.model)) {
      const cached = managedSttModelCached(config.backend, config.model);
      return {
        ready: false,
        status: cached ? "runtime-stopped" : "model-missing",
        message: cached
          ? `${config.displayName} is downloaded - select it in /voice to load the local runtime`
          : `${config.displayName} is not downloaded - select it in /voice to set it up`,
      };
    }
    return { ready: true, status: "ready" };
  }
  if (!validSttEndpoint(config.endpoint, config.backend)) {
    return {
      ready: false,
      status: "endpoint-required",
      message: "Local STT runtime is unavailable - select the model again in /voice",
    };
  }
  return { ready: true, status: "configured" };
}

export function normalizeTranscriptText(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

// Qwen3-ASR's OpenAI-compatible server returns its language metadata and
// transcript marker in the text field. Other compatible servers return plain
// text, so leave responses without the marker unchanged.
export function normalizeOpenAICompatibleTranscriptText(text) {
  const raw = String(text ?? "");
  const marker = /<asr_text>/i.exec(raw);
  return normalizeTranscriptText(marker ? raw.slice(marker.index + marker[0].length) : raw);
}

function responseError(status, body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const message = parsed?.error?.message || parsed?.message || body.trim();
  return `STT server HTTP ${status}${message ? `: ${message.slice(0, 240)}` : ""}`;
}

/**
 * Call a vLLM/OpenAI-compatible audio transcription endpoint. This adapter
 * intentionally owns no server process and stores no API secret: the optional
 * key is read from the configured environment variable for each request.
 */
export async function transcribeOpenAICompatible({
  wavFile,
  model,
  endpoint,
  apiKeyEnv = "",
  language = STT_LANGUAGE_AUTO,
  languageHint = "",
  timeoutMs = 30000,
  logger,
}) {
  const url = transcriptionEndpoint(endpoint);
  if (!validTranscriptionEndpoint(endpoint)) {
    return { error: "Local STT service is unavailable - wait for setup to finish" };
  }
  if (!model) return { error: "No STT model configured" };

  let audio;
  try {
    audio = await fs.readFile(wavFile);
  } catch {
    return { error: `Audio file could not be read: ${wavFile}` };
  }
  if (audio.length <= 44) return { error: "Recording is empty - no audio captured" };

  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), path.basename(wavFile));
  form.append("model", model);
  form.append("response_format", "json");
  const selectedLanguage = normalizeSttLanguage(language);
  if (selectedLanguage !== STT_LANGUAGE_AUTO) {
    form.append("language", languageHint || selectedLanguage);
  }

  const headers = {};
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : "";
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const timeout = Math.max(1000, Number(timeoutMs) || 30000);
  logger?.log("STT", `Starting ${url} model=${model}`, "debug");
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(timeout),
    });
    const body = await response.text();
    if (!response.ok) {
      const error = responseError(response.status, body);
      logger?.log("STT", `${url} failed: ${error}`, "error");
      return { error };
    }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return { error: "STT server returned invalid JSON" };
    }
    if (typeof data?.text !== "string") {
      return { error: "STT server response did not contain a text field" };
    }
    const text = normalizeOpenAICompatibleTranscriptText(data.text);
    logger?.log("STT", `STT server transcription succeeded chars=${text.length}`, "debug");
    return { text };
  } catch (err) {
    const error =
      err?.name === "TimeoutError" ? `STT server timed out after ${timeout / 1000}s` : err.message;
    logger?.log("STT", `STT server request failed: ${error}`, "error");
    return { error: error || "STT server request failed" };
  }
}

function wavPcmData(audio) {
  if (audio.length <= 44 || audio.toString("ascii", 0, 4) !== "RIFF") return null;
  let offset = 12;
  while (offset + 8 <= audio.length) {
    const id = audio.toString("ascii", offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    if (id === "data") {
      const start = offset + 8;
      const end = Math.min(audio.length, start + size);
      return end > start ? audio.subarray(start, end) : null;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

function funAsrText(data) {
  const sentences = Array.isArray(data?.sentences)
    ? data.sentences.reduce((joined, sentence) => {
        const text = sentence?.text || "";
        if (!joined || !text) return `${joined}${text}`;
        const separator = /[A-Za-z0-9]$/.test(joined) && /^[A-Za-z0-9]/.test(text) ? " " : "";
        return `${joined}${separator}${text}`;
      }, "")
    : "";
  return normalizeTranscriptText(sentences || data?.partial || "");
}

const FUN_ASR_LANGUAGE_HINTS = {
  en: "English",
  zh: "中文",
  ja: "日本語",
  ko: "한국어",
};

function funAsrLanguageHint(language) {
  return FUN_ASR_LANGUAGE_HINTS[normalizeSttLanguage(language)] || "";
}

/**
 * Transcribe one WAV snapshot through Fun-ASR's documented WebSocket protocol.
 * The application still opens one session per snapshot today; the protocol
 * itself is stateful, so a persistent recorder session can be added without
 * changing this adapter's wire format.
 */
export async function transcribeFunAsrWebSocket({
  wavFile,
  endpoint,
  language = STT_LANGUAGE_AUTO,
  timeoutMs = 30000,
  logger,
}) {
  if (!validSttEndpoint(endpoint, STT_BACKENDS.FUNASR_WEBSOCKET)) {
    return { error: "Invalid Fun-ASR endpoint - configure a ws:// or wss:// URL in /voice" };
  }
  if (typeof WebSocket !== "function") {
    return { error: "This Node runtime does not provide WebSocket support for Fun-ASR" };
  }

  let audio;
  try {
    audio = await fs.readFile(wavFile);
  } catch {
    return { error: `Audio file could not be read: ${wavFile}` };
  }
  const pcm = wavPcmData(audio);
  if (!pcm) return { error: "Recording is empty or not a PCM WAV file" };
  // The official server does not finalize a stream shorter than its first
  // 960 ms decode window. Pad short snapshots with silence so brief dictation
  // still reaches the final decoder instead of returning an empty result.
  const minPcmBytes = Math.ceil(16000 * 0.96) * 2;
  const payload =
    pcm.length < minPcmBytes ? Buffer.concat([pcm, Buffer.alloc(minPcmBytes - pcm.length)]) : pcm;

  const timeout = Math.max(1000, Number(timeoutMs) || 30000);
  const languageHint = funAsrLanguageHint(language);
  logger?.log("STT", `Starting Fun-ASR WebSocket ${endpoint}`, "debug");
  return await new Promise((resolve) => {
    let socket;
    let settled = false;
    let latestText = "";
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {}
      resolve(result);
    };
    const sendAudio = () => {
      try {
        // Match the official client’s 100 ms, 16 kHz mono PCM framing while
        // keeping the snapshot request finite and independent of wall time.
        for (let offset = 0; offset < payload.length; offset += 3200) {
          socket.send(payload.subarray(offset, offset + 3200));
        }
        socket.send("STOP");
      } catch (err) {
        finish({ error: `Fun-ASR WebSocket send failed: ${err.message}` });
      }
    };
    try {
      socket = new WebSocket(endpoint);
      socket.addEventListener("open", () => socket.send("START"));
      socket.addEventListener("message", (event) => {
        let data;
        try {
          data = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (data.event === "started") {
          if (languageHint) socket.send(`LANGUAGE:${languageHint}`);
          sendAudio();
          return;
        }
        const text = funAsrText(data);
        if (text) latestText = text;
        if (data.is_final || data.event === "stopped") {
          finish({ text: latestText });
        }
      });
      socket.addEventListener("error", () =>
        finish({ error: "Fun-ASR WebSocket connection failed" }),
      );
      socket.addEventListener("close", () => {
        if (!settled)
          finish(
            latestText
              ? { text: latestText }
              : { error: "Fun-ASR WebSocket closed before a result" },
          );
      });
      timer = setTimeout(
        () => finish({ error: `Fun-ASR WebSocket timed out after ${timeout / 1000}s` }),
        timeout,
      );
    } catch (err) {
      finish({ error: `Fun-ASR WebSocket failed: ${err.message}` });
    }
  });
}

export async function transcribeFunAsrLlamaCpp({ wavFile, timeoutMs = 30000, logger, root }) {
  const paths = funAsrLlamaPaths(root);
  const timeout = Math.max(1000, Number(timeoutMs) || 30000);
  // The official llama.cpp CLI has no language flag. Let its Nano checkpoint
  // detect the language instead of passing an unsupported selected-language argument.
  logger?.log("STT", `Starting Fun-ASR llama.cpp ${paths.binary}`, "debug");
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(
      paths.binary,
      ["--enc", paths.encoder, "-m", paths.decoder, "-a", wavFile, "--vad", paths.vad],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ error: `Fun-ASR llama.cpp timed out after ${timeout / 1000}s` });
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-1000);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ error: `Fun-ASR llama.cpp could not start: ${err.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim().split("\n").pop();
        resolve({
          error: detail
            ? `Fun-ASR llama.cpp failed: ${detail}`
            : `Fun-ASR llama.cpp exited with code ${code}`,
        });
        return;
      }
      resolve({ text: normalizeTranscriptText(stdout) });
    });
  });
}

export async function transcribeWithBackend({ config, wavFile, timeoutMs, logger }) {
  if (config?.unavailable) return { error: config.unavailable };
  if (config?.backend === STT_BACKENDS.NEMO) {
    return transcribeNemo({ wavFile, model: config.model, language: config.language, logger });
  }
  if (
    config?.backend === STT_BACKENDS.OPENAI_COMPATIBLE ||
    config?.backend === STT_BACKENDS.FUNASR_HTTP
  ) {
    return transcribeOpenAICompatible({
      wavFile,
      model: config.requestModel || config.model,
      endpoint: config.endpoint,
      apiKeyEnv: config.apiKeyEnv,
      language: config.language,
      languageHint: config.languageHints?.[config.language],
      timeoutMs,
      logger,
    });
  }
  if (config?.backend === STT_BACKENDS.FUNASR_WEBSOCKET) {
    return transcribeFunAsrWebSocket({
      wavFile,
      endpoint: config.endpoint,
      language: config.language,
      timeoutMs,
      logger,
    });
  }
  if (config?.backend === STT_BACKENDS.FUNASR_LLAMA_CPP) {
    return transcribeFunAsrLlamaCpp({ wavFile, timeoutMs, logger });
  }
  return { error: `Unsupported STT backend: ${config?.backend || "unknown"}` };
}
