import assert from "node:assert/strict";
import test from "node:test";

import {
  UI_LANGUAGE_OPTIONS,
  UI_MESSAGE_KEYS,
  normalizeUiLocale,
  translate,
  translationCoverage,
} from "../lib/i18n.js";

test("every selectable language has a complete setup translation pack", () => {
  assert.equal(UI_LANGUAGE_OPTIONS.length, 5);
  assert.ok(UI_LANGUAGE_OPTIONS.every((language) => language.uiSupported));
  assert.ok(UI_LANGUAGE_OPTIONS.every((language) => translationCoverage(language.id)));
  assert.ok(UI_MESSAGE_KEYS.length > 30);
});

test("locale normalization never treats automatic transcription as a UI locale", () => {
  assert.equal(normalizeUiLocale("es"), "es");
  assert.equal(normalizeUiLocale("auto"), "en");
  assert.equal(normalizeUiLocale("not-a-language"), "en");
});

test("translations interpolate setup values", () => {
  assert.equal(
    translate("ja", "readyHold", { key: "ctrl+r" }),
    "ctrl+r を押したまま話してください。",
  );
  assert.equal(translate("ja", "step", { current: 2, total: 5 }), "5 ステップ中 2 ステップ");
});
