import assert from "node:assert/strict";
import test from "node:test";

import { progressBar, recommendNemoModel } from "../lib/setup.js";

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

test("recommends parakeet for English, CLI default otherwise", () => {
  assert.equal(recommendNemoModel("en"), "parakeet-tdt");
  assert.equal(recommendNemoModel("multi"), "");
});
