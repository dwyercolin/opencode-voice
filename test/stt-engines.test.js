import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  STT_BACKENDS,
  STT_MODELS,
  modelSupportsSttLanguage,
  normalizeOpenAICompatibleTranscriptText,
  resolveSttConfig,
  sttReadiness,
  transcribeFunAsrLlamaCpp,
  transcribeFunAsrWebSocket,
  transcribeOpenAICompatible,
  transcriptionEndpoint,
  validSttEndpoint,
  validTranscriptionEndpoint,
} from "../lib/stt-engines.js";
import { funAsrLlamaPaths } from "../lib/stt-runtime-paths.js";

function makeKv(entries = []) {
  const values = new Map(entries);
  return {
    get(key, fallback) {
      return values.has(key) ? values.get(key) : fallback;
    },
    set(key, value) {
      values.set(key, value);
    },
  };
}

function makeTempWav(durationSeconds = 0.01) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-voice-stt-engines-"));
  const file = path.join(dir, "audio.wav");
  const pcm = Buffer.alloc(Math.ceil(16000 * durationSeconds) * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
  return { dir, file };
}

test("resolveSttConfig preserves the legacy NeMo setting", () => {
  const kv = makeKv([["stt.nemo.model", "nemotron-3.5"]]);
  const config = resolveSttConfig(kv, {});

  assert.equal(config.backend, STT_BACKENDS.NEMO);
  assert.equal(config.model, "nemotron-3.5");
  assert.equal(config.id, "nemo:nemotron-3.5");
  assert.equal(config.live, "simulated");
  assert.equal(config.language, "auto");
});

test("resolveSttConfig normalizes an explicit language preference", () => {
  const config = resolveSttConfig(makeKv([["stt.language", " PL "]]), { sttLanguage: "de" });

  assert.equal(config.language, "auto");
});

test("model language metadata lists only the supported shipped languages", () => {
  const parakeet = STT_MODELS["nemo:parakeet-tdt"];
  const qwen = STT_MODELS["remote:qwen3-asr-0.6b"];
  const funNano = STT_MODELS["remote:fun-asr-nano-2512"];
  const funMlt = STT_MODELS["remote:fun-asr-mlt-nano-2512"];

  assert.equal(modelSupportsSttLanguage(parakeet, "es"), true);
  assert.equal(modelSupportsSttLanguage(parakeet, "ko"), false);
  assert.equal(modelSupportsSttLanguage(qwen, "ko"), true);
  assert.equal(modelSupportsSttLanguage(funNano, "ko"), false);
  assert.equal(modelSupportsSttLanguage(funMlt, "ko"), true);
});

test("stale Omnilingual CTC selections are blocked instead of falling back", () => {
  const config = resolveSttConfig(
    makeKv([
      ["stt.model", "omnilingual:ctc-300m"],
      ["stt.endpoint", "local://omnilingual"],
    ]),
    {},
  );

  assert.equal(STT_MODELS["omnilingual:ctc-300m"], undefined);
  assert.deepEqual(sttReadiness(config), {
    ready: false,
    status: "unavailable",
    message:
      "Omnilingual CTC 300M is unavailable because it cannot enforce the selected language. Choose another transcription model in /voice.",
  });
});

test("sttReadiness rejects a model that cannot serve the selected language", () => {
  const config = resolveSttConfig(makeKv([["stt.language", "ko"]]), {
    sttModel: "parakeet-tdt",
  });

  assert.deepEqual(sttReadiness(config), {
    ready: false,
    status: "unsupported-language",
    message: "Parakeet TDT does not list Korean support",
  });
});

test("resolveSttConfig gives Qwen its managed local endpoint", () => {
  const kv = makeKv([
    ["stt.model", "remote:qwen3-asr-0.6b"],
    ["stt.endpoint", "http://localhost:8000/v1/"],
    ["stt.apiKeyEnv", "QWEN_API_KEY"],
  ]);
  const config = resolveSttConfig(kv, {});

  assert.equal(config.backend, STT_BACKENDS.OPENAI_COMPATIBLE);
  assert.equal(config.model, "Qwen/Qwen3-ASR-0.6B");
  assert.equal(config.endpoint, "http://127.0.0.1:8000/v1");
  assert.equal(config.apiKeyEnv, "");
  assert.equal(config.live, "simulated");
});

test("resolveSttConfig gives Fun-ASR MLT its managed local service", () => {
  const kv = makeKv([
    ["stt.model", "remote:fun-asr-mlt-nano-2512"],
    ["stt.endpoint", "ws://127.0.0.1:10095"],
  ]);
  const config = resolveSttConfig(kv, {});

  assert.equal(config.backend, STT_BACKENDS.FUNASR_HTTP);
  assert.equal(config.endpoint, "http://127.0.0.1:10096/v1");
  assert.equal(config.requestModel, "custom");
  assert.equal(config.languageHints.ko, "韩文");
  assert.equal(config.live, "simulated");
});

test("legacy Fun-ASR MLT WebSocket settings use the managed local service", () => {
  const config = resolveSttConfig(
    makeKv([
      ["stt.backend", "funasr-websocket"],
      ["stt.remote.model", "FunAudioLLM/Fun-ASR-MLT-Nano-2512"],
      ["stt.endpoint", "ws://127.0.0.1:10095"],
    ]),
    {},
  );

  assert.equal(config.backend, STT_BACKENDS.FUNASR_HTTP);
  assert.equal(config.endpoint, "http://127.0.0.1:10096/v1");
});

test("resolveSttConfig treats Fun-ASR Nano as the local llama.cpp backend", () => {
  const kv = makeKv([
    ["stt.model", "remote:fun-asr-nano-2512"],
    ["stt.endpoint", "local://fun-asr"],
  ]);
  const config = resolveSttConfig(kv, {});

  assert.equal(config.backend, STT_BACKENDS.FUNASR_LLAMA_CPP);
});

test("static remote options work without runtime kv settings", () => {
  const config = resolveSttConfig(makeKv(), {
    sttBackend: "vllm",
    sttModel: "Qwen/Qwen3-ASR-1.7B",
    sttEndpoint: "http://localhost:8000/v1",
  });

  assert.equal(config.backend, STT_BACKENDS.OPENAI_COMPATIBLE);
  assert.equal(config.id, "remote:qwen3-asr-1.7b");
  assert.equal(config.endpoint, "http://127.0.0.1:8000/v1");
});

test("transcriptionEndpoint appends the OpenAI audio path once", () => {
  assert.equal(
    transcriptionEndpoint("http://localhost:8000/v1/"),
    "http://localhost:8000/v1/audio/transcriptions",
  );
  assert.equal(
    transcriptionEndpoint("http://localhost:8000/v1/audio/transcriptions"),
    "http://localhost:8000/v1/audio/transcriptions",
  );
  assert.equal(validTranscriptionEndpoint("https://example.test/v1"), true);
  assert.equal(validTranscriptionEndpoint("localhost:8000/v1"), false);
  assert.equal(validTranscriptionEndpoint(""), false);
  assert.equal(validSttEndpoint("ws://localhost:10095", STT_BACKENDS.FUNASR_WEBSOCKET), true);
  assert.equal(validSttEndpoint("http://localhost:8000/v1", STT_BACKENDS.FUNASR_WEBSOCKET), false);
});

test("normalizes Qwen protocol metadata without changing plain transcripts", () => {
  assert.equal(
    normalizeOpenAICompatibleTranscriptText("language Chinese<asr_text>你好\n世界"),
    "你好 世界",
  );
  assert.equal(
    normalizeOpenAICompatibleTranscriptText("language Chinese\n<asr_text>hello world"),
    "hello world",
  );
  assert.equal(
    normalizeOpenAICompatibleTranscriptText("language is part of the transcript"),
    "language is part of the transcript",
  );
  assert.equal(normalizeOpenAICompatibleTranscriptText("language None<asr_text>"), "");
});

test("transcribeOpenAICompatible sends multipart audio and reads the transcript", async () => {
  const { dir, file } = makeTempWav();
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.QWEN_API_KEY;
  process.env.QWEN_API_KEY = "test-secret";
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    assert.equal(init.body.get("model"), "Qwen/Qwen3-ASR-0.6B");
    assert.equal(init.body.get("response_format"), "json");
    assert.equal(init.body.get("file").name, "audio.wav");
    return new Response(JSON.stringify({ text: "language Chinese<asr_text>你好\n世界" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const result = await transcribeOpenAICompatible({
      wavFile: file,
      model: "Qwen/Qwen3-ASR-0.6B",
      endpoint: "http://localhost:8000/v1",
      apiKeyEnv: "QWEN_API_KEY",
      language: "zh",
    });
    assert.deepEqual(result, { text: "你好 世界" });
    assert.equal(request.url, "http://localhost:8000/v1/audio/transcriptions");
    assert.equal(request.init.headers.Authorization, "Bearer test-secret");
    assert.equal(request.init.body.get("language"), "zh");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.QWEN_API_KEY;
    else process.env.QWEN_API_KEY = previousKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("transcribeOpenAICompatible uses Fun-ASR MLT's custom model and language hint", async () => {
  const { dir, file } = makeTempWav();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.body.get("model"), "custom");
    assert.equal(init.body.get("language"), "韩文");
    return new Response(JSON.stringify({ text: "안녕하세요" }), { status: 200 });
  };
  try {
    const result = await transcribeOpenAICompatible({
      wavFile: file,
      model: "custom",
      endpoint: "http://127.0.0.1:10096/v1",
      language: "ko",
      languageHint: "韩文",
    });
    assert.deepEqual(result, { text: "안녕하세요" });
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("transcribeOpenAICompatible reports server errors without leaking auth", async () => {
  const { dir, file } = makeTempWav();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "model is loading" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  try {
    const result = await transcribeOpenAICompatible({
      wavFile: file,
      model: "FunAudioLLM/Fun-ASR-Nano-2512",
      endpoint: "http://localhost:8000/v1",
    });
    assert.deepEqual(result, { error: "STT server HTTP 503: model is loading" });
  } finally {
    globalThis.fetch = previousFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("transcribeOpenAICompatible rejects an unconfigured endpoint before reading audio", async () => {
  const result = await transcribeOpenAICompatible({
    wavFile: "/does/not/exist.wav",
    model: "Qwen/Qwen3-ASR-0.6B",
    endpoint: "",
  });
  assert.deepEqual(result, {
    error: "Local STT service is unavailable - wait for setup to finish",
  });
});

test("transcribeFunAsrLlamaCpp returns the native CLI transcript", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-voice-fun-asr-"));
  const paths = funAsrLlamaPaths(dir);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.binary, "#!/bin/sh\nprintf 'Native transcript\\n'");
  fs.chmodSync(paths.binary, 0o755);
  try {
    const result = await transcribeFunAsrLlamaCpp({
      wavFile: "/tmp/audio.wav",
      root: dir,
      timeoutMs: 1000,
    });
    assert.deepEqual(result, { text: "Native transcript" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("transcribeFunAsrLlamaCpp keeps language selection automatic for its CLI", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-voice-fun-asr-"));
  const paths = funAsrLlamaPaths(dir);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.binary, "#!/bin/sh\nprintf '%s\\n' \"$@\"");
  fs.chmodSync(paths.binary, 0o755);
  try {
    const result = await transcribeFunAsrLlamaCpp({
      wavFile: "/tmp/audio.wav",
      language: "ja",
      root: dir,
      timeoutMs: 1000,
    });
    assert.doesNotMatch(result.text, /--language/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("transcribeFunAsrWebSocket follows the START/audio/STOP protocol", async () => {
  const { dir, file } = makeTempWav();
  const previousWebSocket = globalThis.WebSocket;
  const sent = [];
  class FakeWebSocket {
    constructor() {
      this.listeners = new Map();
      setTimeout(() => this.emit("open"), 0);
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    emit(type, event = {}) {
      this.listeners.get(type)?.(event);
    }

    send(value) {
      sent.push(value);
      if (value === "START") {
        setTimeout(() => this.emit("message", { data: JSON.stringify({ event: "started" }) }), 0);
      }
      if (value === "STOP") {
        setTimeout(
          () =>
            this.emit("message", {
              data: JSON.stringify({
                sentences: [{ text: "Hello" }, { text: "world" }],
                is_final: true,
              }),
            }),
          0,
        );
      }
    }

    close() {}
  }
  globalThis.WebSocket = FakeWebSocket;
  try {
    const result = await transcribeFunAsrWebSocket({
      wavFile: file,
      endpoint: "ws://localhost:10095",
      language: "ko",
      timeoutMs: 1000,
    });
    assert.deepEqual(result, { text: "Hello world" });
    assert.equal(sent[0], "START");
    assert.ok(sent.indexOf("LANGUAGE:한국어") > sent.indexOf("START"));
    const audioBytes = sent
      .filter((value) => value instanceof Buffer)
      .reduce((total, value) => total + value.length, 0);
    assert.equal(audioBytes, Math.ceil(16000 * 0.96) * 2);
    assert.ok(sent.indexOf("LANGUAGE:한국어") < sent.findIndex((value) => value instanceof Buffer));
    assert.equal(sent.at(-1), "STOP");
  } finally {
    globalThis.WebSocket = previousWebSocket;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
