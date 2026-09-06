import assert from "node:assert/strict";
import test from "node:test";

import { progressBar, shortModelLabel, spinnerBar } from "../lib/setup.js";

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

test("renders an indeterminate spinner bar", () => {
  assert.equal(spinnerBar(0), "█░░░░░░░░░");
  assert.equal(spinnerBar(3), "░░░█░░░░░░");
  assert.equal(spinnerBar(9), "░░░░░░░░░█");
  assert.equal(spinnerBar(10), "█░░░░░░░░░");
  assert.equal(spinnerBar(-1), "█░░░░░░░░░");
});

test("shortModelLabel keeps the tail of long model ids", () => {
  assert.equal(shortModelLabel("anthropic/claude-sonnet-4-5"), "anthropic/claude-sonnet-4-5");
  assert.equal(shortModelLabel("abcdefghij", 10), "abcdefghij");
  assert.equal(shortModelLabel("abcdefghijkl", 10), "…defghijkl");
  assert.equal(shortModelLabel("abcdefghijkl", 10).length, 10);
  assert.equal(shortModelLabel(""), "");
  assert.equal(shortModelLabel(null), "");
  assert.equal(shortModelLabel(undefined), "");
});
