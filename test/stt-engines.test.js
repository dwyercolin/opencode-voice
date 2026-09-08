import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  STT_BACKENDS,
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

function makeTempWav() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-voice-stt-engines-"));
  const file = path.join(dir, "audio.wav");
  const pcm = Buffer.alloc(320);
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
});

test("resolveSttConfig resolves a configured Qwen remote model", () => {
  const kv = makeKv([
    ["stt.model", "remote:qwen3-asr-0.6b"],
    ["stt.endpoint", "http://127.0.0.1:8000/v1/"],
    ["stt.apiKeyEnv", "QWEN_API_KEY"],
  ]);
  const config = resolveSttConfig(kv, {});

  assert.equal(config.backend, STT_BACKENDS.OPENAI_COMPATIBLE);
  assert.equal(config.model, "Qwen/Qwen3-ASR-0.6B");
  assert.equal(config.endpoint, "http://127.0.0.1:8000/v1/");
  assert.equal(config.apiKeyEnv, "QWEN_API_KEY");
  assert.equal(config.live, "simulated");
  assert.equal(sttReadiness(config).status, "configured");
});

test("resolveSttConfig treats Fun-ASR MLT as a WebSocket backend", () => {
  const kv = makeKv([
    ["stt.model", "remote:fun-asr-mlt-nano-2512"],
    ["stt.endpoint", "ws://127.0.0.1:10095"],
  ]);
  const config = resolveSttConfig(kv, {});

  assert.equal(config.backend, STT_BACKENDS.FUNASR_WEBSOCKET);
  assert.equal(config.live, "simulated");
  assert.equal(sttReadiness(config).status, "configured");
});

test("resolveSttConfig treats Fun-ASR Nano as the local llama.cpp backend", () => {
  const kv = makeKv([
    ["stt.model", "remote:fun-asr-nano-2512"],
    ["stt.endpoint", "local://fun-asr"],
  ]);
  const config = resolveSttConfig(kv, {});

  assert.equal(config.backend, STT_BACKENDS.FUNASR_LLAMA_CPP);
  assert.equal(sttReadiness(config).status, "configured");
});

test("static remote options work without runtime kv settings", () => {
  const config = resolveSttConfig(makeKv(), {
    sttBackend: "vllm",
    sttModel: "Qwen/Qwen3-ASR-1.7B",
    sttEndpoint: "http://localhost:8000/v1",
  });

  assert.equal(config.backend, STT_BACKENDS.OPENAI_COMPATIBLE);
  assert.equal(config.id, "remote:qwen3-asr-1.7b");
  assert.equal(sttReadiness(config).ready, true);
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
    });
    assert.deepEqual(result, { text: "你好 世界" });
    assert.equal(request.url, "http://localhost:8000/v1/audio/transcriptions");
    assert.equal(request.init.headers.Authorization, "Bearer test-secret");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.QWEN_API_KEY;
    else process.env.QWEN_API_KEY = previousKey;
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
    error: "Invalid STT endpoint - configure an http:// or https:// URL in /voice",
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
      timeoutMs: 1000,
    });
    assert.deepEqual(result, { text: "Hello world" });
    assert.equal(sent[0], "START");
    const audioBytes = sent
      .filter((value) => value instanceof Buffer)
      .reduce((total, value) => total + value.length, 0);
    assert.equal(audioBytes, Math.ceil(16000 * 0.96) * 2);
    assert.equal(sent.at(-1), "STOP");
  } finally {
    globalThis.WebSocket = previousWebSocket;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
