import assert from "node:assert/strict";
import test from "node:test";

import { configureGuidedCleanup, createVoiceSetup } from "../lib/setup.js";

function mockGuidedSetup() {
  const values = new Map();
  const opens = [];
  let closeCurrent;
  let rendered;
  let captureKey;
  let currentKey = "ctrl+r";
  let currentMode = "hold";
  const api = {
    renderer: { width: 120 },
    keymap: {
      formatKey(key) {
        return key.ctrl ? `ctrl+${key.name}` : key.name;
      },
      intercept(name, handler) {
        assert.equal(name, "key");
        captureKey = handler;
        return () => {
          if (captureKey === handler) captureKey = undefined;
        };
      },
      registerLayer() {
        return () => {};
      },
    },
    lifecycle: { onDispose() {} },
    ui: {
      DialogAlert: (props) => props,
      DialogPrompt: (props) => props,
      DialogSelect: (props) => props,
      dialog: {
        replace(render, onClose) {
          closeCurrent?.();
          rendered = render();
          closeCurrent = onClose;
          opens.push(rendered);
        },
        clear() {
          const close = closeCurrent;
          close?.();
          closeCurrent = undefined;
          rendered = undefined;
        },
        setSize() {},
        get open() {
          return Boolean(rendered);
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
  const setup = createVoiceSetup({
    api,
    kv,
    client: {},
    state: {},
    logger: { log() {} },
    opts: {},
    toast() {},
    getTalkKey: () => currentKey,
    setTalkKey(value) {
      currentKey = value;
      values.set("voice.key", value);
      return true;
    },
    getVoiceMode: () => currentMode,
    setVoiceMode(mode) {
      currentMode = mode;
      values.set("voice.mode", mode);
    },
  });
  return {
    setup,
    values,
    opens,
    api,
    get rendered() {
      return rendered;
    },
    get captureKey() {
      return captureKey;
    },
  };
}

function select(screen, value) {
  screen.options.find((option) => option.value === value)?.onSelect();
}

async function confirmGuidedKey(testSetup, value = "ctrl+r") {
  const [modifier, name] = value.split("+").length === 2 ? value.split("+") : [null, value];
  testSetup.captureKey({
    event: { name, ctrl: modifier === "ctrl" },
    consume() {},
  });
  await Promise.resolve();
  testSetup.captureKey({ event: { name: "enter" }, consume() {} });
  await Promise.resolve();
  await Promise.resolve();
}

test("language selection uses a clean language-only screen and localizes immediately", async () => {
  const testSetup = mockGuidedSetup();
  testSetup.setup.run({ back() {} });
  const languageScreen = testSetup.rendered;
  assert.equal(languageScreen.title, "Language");
  assert.equal(languageScreen.skipFilter, true);
  assert.equal(
    languageScreen.options.find((option) => option.value === "back").description,
    undefined,
  );
  select(languageScreen, "es");
  await Promise.resolve();

  assert.equal(testSetup.values.get("voice.locale"), "es");
  assert.equal(testSetup.values.get("stt.language"), "es");
  assert.equal(testSetup.rendered.title, "Tecla de voz");
  assert.match(testSetup.rendered.message, /Press the key/);
  await confirmGuidedKey(testSetup);
  assert.equal(testSetup.values.get("voice.key"), "ctrl+r");
  assert.equal(testSetup.rendered.title, "¿Cómo quieres hablar?");
  assert.deepEqual(
    testSetup.rendered.options.slice(0, 2).map((option) => option.value),
    ["hold", "tap"],
  );
});

test("rerunning setup preserves the transcription language chosen in /voice", () => {
  const testSetup = mockGuidedSetup();
  testSetup.values.set("voice.locale", "en");
  testSetup.values.set("stt.language", "ja");

  testSetup.setup.run();

  assert.equal(testSetup.rendered.title, "Language");
  assert.equal(testSetup.rendered.current, "ja");
  assert.equal(testSetup.rendered.options[0].value, "ja");
  assert.equal(testSetup.rendered.options[0].footer, "Selected");
});

test("guided setup lists only models that support the selected language", async () => {
  const testSetup = mockGuidedSetup();
  testSetup.setup.run();
  select(testSetup.rendered, "ko");
  await Promise.resolve();
  await confirmGuidedKey(testSetup);
  select(testSetup.rendered, "tap");

  const modelScreen = testSetup.rendered;
  assert.equal(modelScreen.title, "음성 모델 선택");
  assert.equal(modelScreen.skipFilter, true);
  assert.deepEqual(
    modelScreen.options.map((option) => option.value),
    [
      "nemo:nemotron-3.5",
      "remote:qwen3-asr-0.6b",
      "remote:qwen3-asr-1.7b",
      "remote:fun-asr-mlt-nano-2512",
      "back",
    ],
  );
  assert.equal(testSetup.values.get("stt.language"), "ko");
  assert.equal(testSetup.values.get("voice.mode"), "tap");
});

test("guided setup puts a locally installable language recommendation first", async () => {
  const testSetup = mockGuidedSetup();
  testSetup.setup.run();
  select(testSetup.rendered, "zh");
  await Promise.resolve();
  await confirmGuidedKey(testSetup);
  select(testSetup.rendered, "tap");

  const modelScreen = testSetup.rendered;
  assert.equal(modelScreen.options[0].value, "remote:fun-asr-nano-2512");
  assert.equal(modelScreen.options[0].footer, "推荐");
  assert.equal(
    modelScreen.options.find((option) => option.value === "remote:fun-asr-mlt-nano-2512").footer,
    undefined,
  );
});

test("guided setup preserves cleanup choices or picks the host default", () => {
  const values = new Map();
  const kv = {
    get(key) {
      return values.get(key);
    },
    set(key, value) {
      values.set(key, value);
    },
  };

  configureGuidedCleanup(kv, { available: true, model: "openai/gpt-4o-mini" });
  assert.equal(values.get("cleanup.mode"), "opencode");
  assert.equal(values.get("cleanup.model"), "openai/gpt-4o-mini");

  values.set("cleanup.mode", "skip");
  configureGuidedCleanup(kv, { available: true, model: "anthropic/claude-haiku-4-5" });
  assert.equal(values.get("cleanup.mode"), "skip");
  assert.equal(values.get("cleanup.model"), "openai/gpt-4o-mini");

  const unavailable = new Map();
  configureGuidedCleanup(
    {
      get(key) {
        return unavailable.get(key);
      },
      set(key, value) {
        unavailable.set(key, value);
      },
    },
    { available: false, model: null },
  );
  assert.equal(unavailable.get("cleanup.mode"), "skip");
});
