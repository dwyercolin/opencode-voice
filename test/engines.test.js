import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as engines from "../lib/engines.js";
import {
  buildMultipartTranscriptionRequest,
  buildNemoArgs,
  buildOpenRouterTranscriptionRequest,
  buildWhisperArgs,
  findVadModel,
  isOpenRouterEndpoint,
  sliceWavFrom,
  snapshotPartialWav,
} from "../lib/engines.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencode-voice-engines-"));
}

test("detects OpenRouter STT endpoints", () => {
  assert.equal(isOpenRouterEndpoint("https://openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouterEndpoint("https://openrouter.ai/api/v1/"), true);
  assert.equal(isOpenRouterEndpoint("https://api.openai.com/v1"), false);
});

test("builds OpenRouter STT requests as JSON with base64 audio", () => {
  const audioBuffer = Buffer.from("RIFFfakewav", "utf8");
  const request = buildOpenRouterTranscriptionRequest(
    "openai/whisper-large-v3-turbo",
    audioBuffer,
    "secret",
  );

  assert.deepEqual(request.headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer secret",
  });

  const body = JSON.parse(request.body);
  assert.deepEqual(body, {
    model: "openai/whisper-large-v3-turbo",
    input_audio: {
      data: audioBuffer.toString("base64"),
      format: "wav",
    },
  });
});

test("builds multipart STT requests with auth header", () => {
  const audioBuffer = Buffer.from("RIFFfakewav", "utf8");
  const request = buildMultipartTranscriptionRequest("whisper-large-v3-turbo", audioBuffer, "key1");

  assert.equal(request.headers.Authorization, "Bearer key1");
  assert.equal(request.body instanceof FormData, true);
  assert.equal(request.body.get("model"), "whisper-large-v3-turbo");
});

test("builds whisper-cli args with language", () => {
  assert.deepEqual(buildWhisperArgs("/models/ggml.bin", "/tmp/a.wav", "zh"), [
    "-m",
    "/models/ggml.bin",
    "-f",
    "/tmp/a.wav",
    "-l",
    "zh",
    "-np",
    "-nt",
  ]);
  assert.deepEqual(buildWhisperArgs("/models/ggml.bin", "/tmp/a.wav", null), [
    "-m",
    "/models/ggml.bin",
    "-f",
    "/tmp/a.wav",
    "-l",
    "auto",
    "-np",
    "-nt",
  ]);
});

test("builds whisper-cli args with Silero VAD when a model is provided", () => {
  assert.deepEqual(
    buildWhisperArgs("/models/ggml.bin", "/tmp/a.wav", "en", "/models/ggml-silero-v6.2.0.bin"),
    [
      "-m",
      "/models/ggml.bin",
      "-f",
      "/tmp/a.wav",
      "-l",
      "en",
      "-np",
      "-nt",
      "--vad",
      "--vad-model",
      "/models/ggml-silero-v6.2.0.bin",
    ],
  );
  // No VAD model means no VAD flags
  const withoutVad = buildWhisperArgs("/m.bin", "/tmp/a.wav", "en", null);
  assert.equal(withoutVad.includes("--vad"), false);
});

test("finds VAD models, preferring newer versions across dirs", () => {
  const dirA = makeTempDir();
  const dirB = makeTempDir();
  try {
    fs.writeFileSync(path.join(dirA, "ggml-silero-v5.1.2.bin"), "x");
    fs.writeFileSync(path.join(dirB, "ggml-silero-v6.2.0.bin"), "x");

    assert.equal(findVadModel([dirA, dirB]), path.join(dirB, "ggml-silero-v6.2.0.bin"));
    assert.equal(findVadModel([dirA]), path.join(dirA, "ggml-silero-v5.1.2.bin"));
    assert.equal(findVadModel([makeTempDir()]), null);
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test("builds nemo-speech transcribe args with and without a model", () => {
  assert.deepEqual(buildNemoArgs("/tmp/a.wav"), ["--quiet", "transcribe", "/tmp/a.wav"]);
  assert.deepEqual(buildNemoArgs("/tmp/a.wav", "parakeet-tdt"), [
    "--quiet",
    "transcribe",
    "/tmp/a.wav",
    "--model",
    "parakeet-tdt",
  ]);
});

function writeFakeWav(
  file,
  { riffSize = 0, dataSize = 0, audioBytes = 32000, withDataChunk = true },
) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(riffSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt32LE(1, 20); // PCM
  header.writeUInt16LE(1, 20 + 4); // channels (offset via fmt body)
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  if (!withDataChunk) header.write("junk", 36, "ascii");
  const audio = Buffer.alloc(audioBytes, 0x01);
  fs.writeFileSync(file, Buffer.concat([header, audio]));
}

test("snapshots in-progress WAV with patched RIFF and data sizes", () => {
  const dir = makeTempDir();
  try {
    const src = path.join(dir, "rec.wav");
    const dst = path.join(dir, "partial.wav");
    writeFakeWav(src, { audioBytes: 32000 });

    assert.equal(snapshotPartialWav(src, dst), true);
    const out = fs.readFileSync(dst);
    assert.equal(out.length, 44 + 32000);
    assert.equal(out.readUInt32LE(4), out.length - 8);
    assert.equal(out.readUInt32LE(40), out.length - 44);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects snapshots with no usable audio yet", () => {
  const dir = makeTempDir();
  try {
    const src = path.join(dir, "rec.wav");
    const dst = path.join(dir, "partial.wav");

    // Missing source
    assert.equal(snapshotPartialWav(path.join(dir, "nope.wav"), dst), false);

    // Header only, no data bytes
    writeFakeWav(src, { audioBytes: 0 });
    assert.equal(snapshotPartialWav(src, dst), false);

    // No data chunk at all
    writeFakeWav(src, { audioBytes: 32000, withDataChunk: false });
    assert.equal(snapshotPartialWav(src, dst), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("slices WAV data from a file-relative byte offset with patched sizes", () => {
  const dir = makeTempDir();
  try {
    const src = path.join(dir, "rec.wav");
    const dst = path.join(dir, "tail.wav");
    writeFakeWav(src, { audioBytes: 64000 }); // 44 header + 64000 data

    // Slice from file offset 44 + 32000 (i.e. skip the first 1s of audio)
    const written = sliceWavFrom(src, dst, 44 + 32000);
    assert.equal(written, 32000);
    const out = fs.readFileSync(dst);
    assert.equal(out.length, 44 + 32000);
    assert.equal(out.readUInt32LE(4), out.length - 8);
    assert.equal(out.readUInt32LE(40), 32000);
    // Data content preserved from the sliced region
    assert.equal(out.subarray(44).equals(fs.readFileSync(src).subarray(44 + 32000)), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sliceWavFrom handles clamping, zero-offset, and failures", () => {
  const dir = makeTempDir();
  try {
    const src = path.join(dir, "rec.wav");
    const dst = path.join(dir, "tail.wav");
    writeFakeWav(src, { audioBytes: 32000 });

    // Offset beyond the data clamps to the end: nothing to slice
    assert.equal(sliceWavFrom(src, dst, 44 + 32000 + 1000), -1);

    // Offset of 0 slices the whole file
    assert.equal(sliceWavFrom(src, dst, 0), 32000);
    assert.equal(fs.statSync(dst).size, 44 + 32000);

    // Header-only offset also slices everything
    assert.equal(sliceWavFrom(src, dst, 44), 32000);

    // Missing source
    assert.equal(sliceWavFrom(path.join(dir, "nope.wav"), dst, 0), -1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("model tables use valid identifiers for their CLIs", () => {
  const { WHISPER_MODELS, NEMO_MODELS } = engines;
  for (const v of Object.values(WHISPER_MODELS)) {
    assert.match(v.file, /^ggml-.*\.bin$/);
  }
  for (const key of Object.keys(NEMO_MODELS)) {
    assert.equal(key === "" || /^[a-z0-9.-]+$/.test(key), true);
  }
});
