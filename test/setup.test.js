import assert from "node:assert/strict";
import test from "node:test";

import { formatAge, progressBar, spinnerBar } from "../lib/setup.js";

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

test("formatAge says whether probe results are fresh or reused", () => {
  // A run that just finished must not look like cached numbers.
  assert.equal(formatAge(0), "just tested");
  assert.equal(formatAge(4000), "just tested");
  assert.equal(formatAge(40_000), "tested 40s ago");
  assert.equal(formatAge(120_000), "tested 2m ago");
  // Results expire at 5 minutes, so anything older is a re-probe.
  assert.equal(formatAge(4 * 60_000), "tested 4m ago");
  assert.equal(formatAge(-5), "just tested");
  assert.equal(formatAge(null), "just tested");
});
