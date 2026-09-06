import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  binaryCommand,
  buildNemoArgs,
  hasBinary,
  sliceWavFrom,
  snapshotPartialWav,
  soxInstallCommand,
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

test("hasBinary reports a missing binary as false", () => {
  assert.equal(hasBinary("opencode-voice-no-such-binary"), false);
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
