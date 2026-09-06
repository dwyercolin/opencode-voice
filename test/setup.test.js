import assert from "node:assert/strict";
import test from "node:test";

import { progressBar, recommendEngine } from "../lib/setup.js";

test("renders a compact progress bar", () => {
  assert.equal(progressBar(0), "░░░░░░░░░░");
  assert.equal(progressBar(47), "█████░░░░░");
  assert.equal(progressBar(50), "█████░░░░░");
  assert.equal(progressBar(100), "██████████");
  assert.equal(progressBar(120), "██████████");
  assert.equal(progressBar(-5), "░░░░░░░░░░");
  assert.equal(progressBar(null), "░░░░░░░░░░");
  assert.equal(progressBar(100, 4), "████");
});

test("recommends parakeet for English when nemo is installed", () => {
  const { recommendation, options } = recommendEngine({
    language: "en",
    hardware: "modest",
    nemoInstalled: true,
    whisperInstalled: false,
    apiConfigured: false,
  });
  assert.equal(recommendation.engine, "nemo");
  assert.equal(recommendation.nemoModel, "parakeet-tdt");
  assert.equal(options.length, 1);
});

test("recommends nemotron (not parakeet) for other languages", () => {
  const { recommendation } = recommendEngine({
    language: "multi",
    hardware: "modern",
    nemoInstalled: true,
    whisperInstalled: true,
    apiConfigured: false,
  });
  assert.equal(recommendation.engine, "nemo");
  assert.equal(recommendation.nemoModel, "");
});

test("suggests a small whisper model on modest hardware", () => {
  const { recommendation } = recommendEngine({
    language: "multi",
    hardware: "modest",
    nemoInstalled: false,
    whisperInstalled: true,
    apiConfigured: false,
  });
  assert.equal(recommendation.engine, "whisper");
  assert.equal(recommendation.whisperModel, "base");
});

test("suggests large whisper on modern hardware without nemo", () => {
  const { recommendation } = recommendEngine({
    language: "multi",
    hardware: "modern",
    nemoInstalled: false,
    whisperInstalled: true,
    apiConfigured: false,
  });
  assert.equal(recommendation.whisperModel, "large-v3-turbo-q5_0");
});

test("falls back to the API when nothing local is available", () => {
  const { recommendation } = recommendEngine({
    language: "en",
    hardware: "modest",
    nemoInstalled: false,
    whisperInstalled: false,
    apiConfigured: true,
  });
  assert.equal(recommendation.engine, "api");
});

test("returns nothing when no option exists", () => {
  const { recommendation, options } = recommendEngine({
    language: "en",
    hardware: "modern",
    nemoInstalled: false,
    whisperInstalled: false,
    apiConfigured: false,
  });
  assert.equal(recommendation, null);
  assert.equal(options.length, 0);
});
