import assert from "node:assert/strict";
import test from "node:test";

import { progressBar, spinnerBar } from "../lib/setup.js";

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
