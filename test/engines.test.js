import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_NEMO_MODEL,
  NEMO_MODELS,
  binaryCommand,
  buildNemoArgs,
  hasBinary,
  hasVerifiedNemoModel,
  invalidateBinaryCache,
  nemoModelRepo,
  nemoModelState,
  normalizeNemoModel,
  parseNemoDownloadTotal,
  sliceWavFrom,
  snapshotPartialWav,
  soxInstallCommand,
  transcribeTimeoutMs,
} from "../lib/engines.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencode-voice-engines-"));
}

test("builds nemo-speech transcribe args with and without a model", () => {
  assert.deepEqual(buildNemoArgs("/tmp/a.wav"), ["--quiet", "transcribe", "/tmp/a.wav"]);
  assert.deepEqual(buildNemoArgs("/tmp/a.wav", "parakeet-tdt"), [
    "--quiet",
    "transcribe",
    "/tmp/a.wav",
    "--model",
    "parakeet-tdt",
  ]);
  assert.deepEqual(buildNemoArgs("/tmp/a.wav", "nemotron-3.5", "ko"), [
    "--quiet",
    "transcribe",
    "/tmp/a.wav",
    "--model",
    "nemotron-3.5",
    "--language",
    "ko",
  ]);
});

test("sox install command names the system package manager", () => {
  assert.equal(soxInstallCommand("darwin"), "brew install sox");
  // Debian/Ubuntu split sox's PulseAudio driver and the pactl tools into
  // separate packages; recording needs all three.
  assert.equal(
    soxInstallCommand("linux"),
    "sudo apt install sox libsox-fmt-pulse pulseaudio-utils",
  );
  // Any other platform gets the Linux instruction rather than nothing.
  assert.equal(soxInstallCommand("win32"), soxInstallCommand("linux"));
});

test("binaryCommand falls back to the bare name when ~/.local/bin has no such file", () => {
  assert.equal(binaryCommand("opencode-voice-no-such-binary"), "opencode-voice-no-such-binary");
});

test("hasVerifiedNemoModel keys on the CLI's .gguf.verified marker, per model", () => {
  const dir = makeTempDir();
  const cache = path.join(dir, "models");
  try {
    // Fresh install: cache dir missing or without verified models.
    assert.equal(hasVerifiedNemoModel("parakeet-tdt", path.join(dir, "missing")), false);
    const modelDir = path.join(cache, "nvidia", "parakeet-tdt-0.6b-v3", "abc123");
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, "parakeet-tdt.q8_0.gguf.partial"), "x");
    assert.equal(hasVerifiedNemoModel("parakeet-tdt", cache), false);
    // The verification marker, exactly as the CLI leaves it.
    fs.writeFileSync(path.join(modelDir, "parakeet-tdt.q8_0.gguf.verified"), "");
    assert.equal(hasVerifiedNemoModel("parakeet-tdt", cache), true);
    // A cached model says nothing about the OTHER models: each one is its own
    // download, and answering "yes" here for a model that is not on disk is
    // what let a model switch stall inside a dictation.
    assert.equal(hasVerifiedNemoModel("parakeet-ctc", cache), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("nemoModelRepo maps short names to the repo the CLI caches under", () => {
  assert.equal(nemoModelRepo("nemotron-3.5"), "nvidia/nemotron-3.5-asr-streaming-0.6b");
  assert.equal(nemoModelRepo("parakeet-ctc"), "nvidia/parakeet-ctc-1.1b");
  // Settings written before every model had its own key hold "", which named
  // the CLI's multilingual default. It must still resolve to a real repo -
  // `pull` needs a name, and an empty one would build a bare `pull`.
  assert.equal(nemoModelRepo(""), "nvidia/nemotron-3.5-asr-streaming-0.6b");
  // A full repo id passes through, so a model outside the table still works.
  assert.equal(nemoModelRepo("nvidia/whatever-1b"), "nvidia/whatever-1b");
  assert.equal(nemoModelRepo("no-such-model"), "");
});

test("normalizeNemoModel tells 'unset' apart from 'the multilingual default'", () => {
  // The bug this exists to prevent: "" read as unset in one place (falling
  // back to Parakeet) and as a real choice in another (Nemotron), so setup
  // downloaded one model and then demanded a second before moving on.
  assert.equal(normalizeNemoModel(""), "nemotron-3.5");
  assert.equal(normalizeNemoModel(undefined), DEFAULT_NEMO_MODEL);
  assert.equal(normalizeNemoModel(null), DEFAULT_NEMO_MODEL);
  // A stored choice is returned untouched, including a bare repo id.
  assert.equal(normalizeNemoModel("parakeet-ctc"), "parakeet-ctc");
  assert.equal(normalizeNemoModel("nvidia/whatever-1b"), "nvidia/whatever-1b");
  // Every key it can return is one the CLI actually accepts.
  assert.ok(NEMO_MODELS[normalizeNemoModel("")]);
  assert.ok(NEMO_MODELS[normalizeNemoModel(undefined)]);
});

test("nemoModelState separates ready, part-downloaded, and missing", () => {
  const dir = makeTempDir();
  const cache = path.join(dir, "models");
  try {
    assert.deepEqual(nemoModelState("parakeet-ctc", cache), { status: "missing", bytes: 0 });
    const modelDir = path.join(cache, "nvidia", "parakeet-ctc-1.1b", "abc123");
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, "parakeet-ctc.q8_0.gguf.partial"), "0123456789");
    // A partial carries how far the download got, for a real percentage.
    assert.deepEqual(nemoModelState("parakeet-ctc", cache), { status: "partial", bytes: 10 });
    // The CLI leaves a .lock behind even on a COMPLETED download, so a lock
    // must never be read as "still downloading".
    fs.writeFileSync(path.join(modelDir, "parakeet-ctc.q8_0.gguf.lock"), "");
    fs.writeFileSync(path.join(modelDir, "parakeet-ctc.q8_0.gguf.verified"), "");
    assert.equal(nemoModelState("parakeet-ctc", cache).status, "ready");
    // A name with no known repo cannot be probed at all; say so rather than
    // reporting a missing download.
    assert.equal(nemoModelState("no-such-model", cache).status, "unknown");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("parseNemoDownloadTotal reads the size the CLI announces before curl runs", () => {
  // curl's own percentages only exist when stderr is a TTY, so this line is
  // the only progress signal that survives the plugin's pipe.
  assert.equal(
    parseNemoDownloadTotal(
      "[model] downloading nvidia/parakeet-ctc-1.1b@20e63a0f (asr, 1123.5 MiB)",
    ),
    Math.round(1123.5 * 1024 ** 2),
  );
  assert.equal(
    parseNemoDownloadTotal("[model] downloading x (1.4 GiB)"),
    Math.round(1.4 * 1024 ** 3),
  );
  assert.equal(parseNemoDownloadTotal("[model] license: CC-BY-4.0"), 0);
  assert.equal(parseNemoDownloadTotal(""), 0);
  assert.equal(parseNemoDownloadTotal(null), 0);
});

test("transcribeTimeoutMs gives the first-run download room and stays tight after", () => {
  assert.equal(transcribeTimeoutMs(false), 30 * 60_000);
  assert.equal(transcribeTimeoutMs(true), 180_000);
});

test("hasBinary reports a missing binary as false", () => {
  assert.equal(hasBinary("opencode-voice-no-such-binary"), false);
});

test("hasBinary keys on executables on PATH, not on flag conventions", () => {
  const dir = makeTempDir();
  const savedPath = process.env.PATH;
  process.env.PATH = `${dir}:${savedPath}`;
  try {
    const bin = path.join(dir, "opencode-voice-fake-bin");
    // An executable file is found whether or not it understands --version:
    // xclip exits nonzero on --version yet works fine, which the old
    // execution probe misread as "not installed".
    fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(bin, 0o755);
    invalidateBinaryCache();
    assert.equal(hasBinary("opencode-voice-fake-bin"), true);
    // Losing the executable bit means not installed.
    fs.chmodSync(bin, 0o644);
    invalidateBinaryCache();
    assert.equal(hasBinary("opencode-voice-fake-bin"), false);
  } finally {
    process.env.PATH = savedPath;
    invalidateBinaryCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

    assert.equal(snapshotPartialWav(path.join(dir, "nope.wav"), dst), false);

    writeFakeWav(src, { audioBytes: 0 });
    assert.equal(snapshotPartialWav(src, dst), false);

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
