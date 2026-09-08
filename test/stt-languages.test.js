import assert from "node:assert/strict";
import test from "node:test";

import {
  STT_LANGUAGE_AUTO,
  modelSupportsSttLanguage,
  normalizeSttLanguage,
  sttLanguageLabel,
} from "../lib/stt-languages.js";

test("normalizes known and unknown language preferences", () => {
  assert.equal(normalizeSttLanguage(" KO "), "ko");
  assert.equal(normalizeSttLanguage("pl"), STT_LANGUAGE_AUTO);
  assert.equal(normalizeSttLanguage("unknown"), STT_LANGUAGE_AUTO);
  assert.equal(normalizeSttLanguage(null), STT_LANGUAGE_AUTO);
});

test("translates language metadata for display", () => {
  assert.equal(sttLanguageLabel("ko"), "Korean");
});

test("unknown model coverage remains available until a runtime reports it", () => {
  assert.equal(modelSupportsSttLanguage({ languages: ["en"] }, "ko"), false);
  assert.equal(modelSupportsSttLanguage({ languages: null }, "ko"), true);
  assert.equal(modelSupportsSttLanguage({ languages: ["en"] }, "auto"), true);
});
