import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAudioHint,
  buildRecordArgs,
  combinePromptText,
  DEFAULT_VOICE_KEY,
  disambiguateLabels,
  isWSL,
  liveTranscriptTarget,
  needsNormalization,
  parsePactlSources,
  parsePactlSourcesShort,
  preferPunctuatedPartial,
  registerSTT,
  resolveVoiceKey,
  shortDeviceId,
  stripOverlappingWords,
} from "../lib/stt.js";

test("resolveVoiceKey prefers persisted, option, and default values in order", () => {
  const values = new Map();
  const kv = {
    get(key, fallback) {
      return values.has(key) ? values.get(key) : fallback;
    },
  };

  assert.equal(resolveVoiceKey(kv, { voiceKey: " f2 " }), "f2");
  assert.equal(resolveVoiceKey(kv, {}), DEFAULT_VOICE_KEY);

  values.set("voice.key", " <leader>v ");
  assert.equal(resolveVoiceKey(kv, { voiceKey: "f2" }), "<leader>v");
  values.set("voice.key", "");
  assert.equal(resolveVoiceKey(kv, { voiceKey: "f2" }), "f2");
});

test("/voice changes the active talk key binding", () => {
  const values = new Map([["voice.setupDone", true]]);
  const layers = [];
  const toasts = [];
  let rendered;
  let closeCurrent;
  let captureKey;
  const api = {
    client: { tui: {} },
    keymap: {
      formatKey(key) {
        return key.ctrl ? `ctrl+${key.name}` : key.name;
      },
      intercept(name, handler) {
        assert.equal(name, "key");
        captureKey = handler;
        return () => {
          captureKey = undefined;
        };
      },
      parseKeySequence(key) {
        if (key === "invalid") throw new Error("invalid key");
        return [key];
      },
      registerLayer(layer) {
        const registration = { layer, disposed: false };
        layers.push(registration);
        return () => {
          registration.disposed = true;
        };
      },
    },
    lifecycle: { onDispose() {} },
    renderer: { width: 120 },
    state: {},
    ui: {
      DialogAlert: (props) => props,
      DialogPrompt: (props) => props,
      DialogSelect: (props) => props,
      toast(value) {
        toasts.push(value);
      },
      dialog: {
        replace(render, onClose) {
          closeCurrent?.();
          rendered = render();
          closeCurrent = onClose;
        },
        setSize() {},
        clear() {
          const close = closeCurrent;
          closeCurrent = undefined;
          rendered = undefined;
          close?.();
        },
        get open() {
          return rendered !== undefined;
        },
      },
    },
  };
  const kv = {
    get(key, fallback) {
      return values.has(key) ? values.get(key) : fallback;
    },
    set(key, value) {
      values.set(key, value);
    },
  };
  const logger = { log() {} };
  const commands = registerSTT(
    api,
    kv,
    async () => ({ text: null }),
    { liveTranscript: false },
    logger,
  );

  assert.equal(layers.length, 2);
  commands[1].onSelect();
  const keyRow = rendered.options.find((option) => option.value === "key");
  keyRow.onSelect();
  let consumed = false;
  captureKey({
    event: { name: "k", ctrl: true },
    consume() {
      consumed = true;
    },
  });

  assert.match(rendered.message, /Selected: ctrl\+k/);
  captureKey({
    event: { name: "return" },
    consume() {},
  });

  assert.equal(values.get("voice.key"), "ctrl+k");
  assert.equal(layers[1].disposed, true);
  assert.equal(layers[2].layer.bindings[0].key, "ctrl+k");
  assert.equal(consumed, true);
  assert.equal(toasts.at(-1).message, "Voice keybind: ctrl+k");

  rendered.options.find((option) => option.value === "key").onSelect();
  captureKey({ event: { name: "escape" }, consume() {} });
  assert.equal(rendered, undefined);
});

test("parses pactl JSON sources and filters out monitors", () => {
  const json = JSON.stringify([
    { name: "RDPSink.monitor", description: "Monitor of RDP Sink" },
    { name: "RDPSource", description: "RDP Source" },
    { name: "alsa_input.usb-mic" },
  ]);
  // The device id is for sox, not the picker: descriptions stand alone.
  assert.deepEqual(parsePactlSources(json), [
    { name: "RDPSource", label: "RDP Source" },
    { name: "alsa_input.usb-mic", label: "usb-mic" },
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

test("shortDeviceId drops the alsa routing prefix and suffix", () => {
  assert.equal(
    shortDeviceId("alsa_input.usb-046d_Brio_100_254AP3-02.mono-fallback"),
    "usb-046d_Brio_100_254AP3-02",
  );
  assert.equal(shortDeviceId("alsa_output.pci-0000_00_1f.3.analog-stereo"), "pci-0000_00_1f.3");
  assert.equal(shortDeviceId("RDPSource"), "RDPSource");
  assert.equal(shortDeviceId(""), "");
  assert.equal(shortDeviceId(null), "");
});

test("identical device descriptions keep their ids to stay distinguishable", () => {
  const json = JSON.stringify([
    { name: "alsa_input.usb-046d_Brio_A-02.mono-fallback", description: "Brio 100 Mono" },
    { name: "alsa_input.usb-046d_Brio_B-02.mono-fallback", description: "Brio 100 Mono" },
    { name: "alsa_input.usb-yeti-00.analog-stereo", description: "Yeti Stereo" },
  ]);
  assert.deepEqual(parsePactlSources(json), [
    {
      name: "alsa_input.usb-046d_Brio_A-02.mono-fallback",
      label: "Brio 100 Mono (usb-046d_Brio_A-02)",
    },
    {
      name: "alsa_input.usb-046d_Brio_B-02.mono-fallback",
      label: "Brio 100 Mono (usb-046d_Brio_B-02)",
    },
    // The unique one is left alone.
    { name: "alsa_input.usb-yeti-00.analog-stereo", label: "Yeti Stereo" },
  ]);
});

test("disambiguateLabels leaves unique labels untouched", () => {
  const devices = [
    { name: "alsa_input.a.mono-fallback", label: "Mic A" },
    { name: "alsa_input.b.mono-fallback", label: "Mic B" },
  ];
  assert.deepEqual(disambiguateLabels(devices), devices);
  assert.deepEqual(disambiguateLabels([]), []);
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

test("live transcript goes to the prompt unless toast is asked for by name", () => {
  // A plugin loaded as a bare path has no options object, so the default must
  // remain prompt rather than silently moving dictation into notifications.
  assert.equal(liveTranscriptTarget(undefined), "prompt");
  assert.equal(liveTranscriptTarget(null), "prompt");
  assert.equal(liveTranscriptTarget(""), "prompt");
  assert.equal(liveTranscriptTarget("prompt"), "prompt");
  // Toast is opt-in and exact: a typo must not silently move dictation out of
  // the prompt, which is the failure mode being removed.
  assert.equal(liveTranscriptTarget("toast"), "toast");
  assert.equal(liveTranscriptTarget("TOAST"), "prompt");
  assert.equal(liveTranscriptTarget("nonsense"), "prompt");
});
