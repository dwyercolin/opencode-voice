import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAudioHint,
  buildRecordArgs,
  combinePromptText,
  isWSL,
  needsNormalization,
  parsePactlSources,
  parsePactlSourcesShort,
  preferPunctuatedPartial,
  stripOverlappingWords,
} from "../lib/stt.js";

test("parses pactl JSON sources and filters out monitors", () => {
  const json = JSON.stringify([
    { name: "RDPSink.monitor", description: "Monitor of RDP Sink" },
    { name: "RDPSource", description: "RDP Source" },
    { name: "alsa_input.usb-mic" },
  ]);
  assert.deepEqual(parsePactlSources(json), [
    { name: "RDPSource", label: "RDP Source (RDPSource)" },
    { name: "alsa_input.usb-mic", label: "alsa_input.usb-mic" },
  ]);
});

test("parses pactl short sources and filters out monitors", () => {
  const short = [
    "1\tRDPSink.monitor\tmodule-rdp-sink.c\ts16le 2ch 44100Hz\tSUSPENDED",
    "2\tRDPSource\tmodule-rdp-source.c\ts16le 1ch 44100Hz\tSUSPENDED",
    "",
  ].join("\n");
  assert.deepEqual(parsePactlSourcesShort(short), [{ name: "RDPSource", label: "RDPSource" }]);
});

test("builds sox record args per audio backend", () => {
  assert.deepEqual(buildRecordArgs("pulseaudio", "RDPSource"), ["-t", "pulseaudio", "RDPSource"]);
  assert.deepEqual(buildRecordArgs("pulseaudio", null), ["-t", "pulseaudio", "default"]);
  assert.deepEqual(buildRecordArgs("coreaudio", "USB Microphone"), [
    "-t",
    "coreaudio",
    "USB Microphone",
  ]);
  assert.deepEqual(buildRecordArgs("coreaudio", null), ["-d"]);
  assert.deepEqual(buildRecordArgs("default", null), ["-d"]);
});

test("builds audio hints per backend and server state", () => {
  assert.match(
    buildAudioHint({ backend: "pulseaudio", serverOk: false, isWsl: true }),
    /wsl --shutdown/,
  );
  assert.match(
    buildAudioHint({ backend: "pulseaudio", serverOk: false, isWsl: false }),
    /PipeWire\/PulseAudio/,
  );
  assert.match(
    buildAudioHint({ backend: "pulseaudio", serverOk: true, isWsl: false }),
    /input source configuration/,
  );
  assert.equal(
    buildAudioHint({ backend: "coreaudio", serverOk: false, isWsl: false }),
    "No input devices found",
  );
});

test("detects WSL via environment variables", () => {
  const savedDistro = process.env.WSL_DISTRO_NAME;
  const savedInterop = process.env.WSL_INTEROP;
  try {
    delete process.env.WSL_DISTRO_NAME;
    delete process.env.WSL_INTEROP;
    assert.equal(isWSL(), false);
    process.env.WSL_DISTRO_NAME = "Ubuntu";
    assert.equal(isWSL(), true);
  } finally {
    if (savedDistro === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = savedDistro;
    if (savedInterop === undefined) delete process.env.WSL_INTEROP;
    else process.env.WSL_INTEROP = savedInterop;
  }
});

test("stripOverlappingWords returns full tail when there is no previous text", () => {
  assert.equal(stripOverlappingWords(null, "hello world"), "hello world");
  assert.equal(stripOverlappingWords("", "hello world"), "hello world");
});

test("stripOverlappingWords strips repeated overlap despite punctuation and case", () => {
  // Interim ends mid-sentence; the tail pass re-transcribes the last second
  assert.equal(
    stripOverlappingWords("fix the login bug in", "login bug in the auth module"),
    "the auth module",
  );
  assert.equal(stripOverlappingWords("use the cache", "Use the cache, then flush"), "then flush");
});

test("stripOverlappingWords strips nothing when words genuinely differ", () => {
  assert.equal(stripOverlappingWords("fix the logs", "and then deploy"), "and then deploy");
});

test("stripOverlappingWords caps the match window to avoid over-stripping", () => {
  const prev = "one two three four five six";
  const tail = "one two three four five six seven eight";
  // Greedy match is capped at 6 words; the rest is kept
  assert.equal(stripOverlappingWords(prev, tail), "seven eight");
});

test("preferPunctuatedPartial keeps punctuation when words are unchanged", () => {
  // Observed with parakeet: same audio re-emitted without punctuation
  assert.equal(
    preferPunctuatedPartial(
      "Great. This is great. This should be the working test.",
      "great this is great this should be the working test",
    ),
    "Great. This is great. This should be the working test.",
  );
});

test("preferPunctuatedPartial keeps punctuated text on one-word growth", () => {
  assert.equal(
    preferPunctuatedPartial("This should be it.", "this should be it now"),
    "This should be it.",
  );
});

test("preferPunctuatedPartial takes fresh text when it genuinely extends", () => {
  assert.equal(
    preferPunctuatedPartial("This should be it.", "This should be it. Plus more words"),
    "This should be it. Plus more words",
  );
});

test("preferPunctuatedPartial takes fresh text when words differ", () => {
  assert.equal(
    preferPunctuatedPartial("Fix the logs.", "Fix the cache now."),
    "Fix the cache now.",
  );
});

test("combinePromptText joins base and addition with a space", () => {
  assert.equal(
    combinePromptText("first dictation", "second dictation"),
    "first dictation second dictation",
  );
  assert.equal(combinePromptText(null, "only"), "only");
  assert.equal(combinePromptText("only", null), "only");
  assert.equal(combinePromptText(null, null), null);
});

test("needsNormalization skips already-clean dictations", () => {
  // Real benchmark cases where the LLM returned the input unchanged (4-26s wasted)
  assert.equal(
    needsNormalization(
      "It works great, however it still clears everything any time I try to append using voice.",
    ),
    false,
  );
  assert.equal(needsNormalization("Can you set up my opencode to run the current update?"), false);
  assert.equal(
    needsNormalization("The live transcription is working now. Let's test another comment."),
    false,
  );
});

test("needsNormalization flags fillers, homophones, and missing punctuation", () => {
  assert.equal(needsNormalization("um check the locks for the doc container"), true);
  assert.equal(needsNormalization("the bullion flag is false and the cash layer"), true);
  assert.equal(needsNormalization("yeah the umm transcription works"), true);
  assert.equal(needsNormalization("this has no terminal punctuation"), true);
  assert.equal(needsNormalization("starts lowercase but ends fine."), true);
  assert.equal(needsNormalization(""), false);
  assert.equal(needsNormalization(null), false);
});
