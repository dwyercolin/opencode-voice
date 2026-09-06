import assert from "node:assert/strict";
import test from "node:test";

import { AUTOGAIN_MAX_BOOST_DB, computeAutoGainDb, parseRmsDb } from "../lib/audio.js";

test("computes no gain for loud enough or invalid input", () => {
  assert.equal(computeAutoGainDb(-18), 0);
  assert.equal(computeAutoGainDb(-31.9), 0);
  assert.equal(computeAutoGainDb(null), 0);
  assert.equal(computeAutoGainDb(Number.NaN), 0);
  assert.equal(computeAutoGainDb(undefined), 0);
});

test("computes gain that lifts quiet input to the target", () => {
  // -40 dB measured -> target -18 -> +22 dB
  assert.equal(computeAutoGainDb(-40), 22);
  // Just under the threshold gets a small nudge
  assert.equal(computeAutoGainDb(-32.4), 14);
  // Severely quiet input is capped
  assert.ok(computeAutoGainDb(-80) <= AUTOGAIN_MAX_BOOST_DB);
  assert.equal(computeAutoGainDb(-80), 28);
});

test("honors custom thresholds", () => {
  assert.equal(computeAutoGainDb(-25, { minRmsDb: -30 }), 0);
  assert.equal(computeAutoGainDb(-25, { minRmsDb: -22, targetDb: -20 }), 5);
  assert.equal(computeAutoGainDb(-60, { maxBoostDb: 10 }), 10);
});

test("parses RMS level from sox stats output", () => {
  const stats = [
    "Stats for file 'x'",
    "",
    "Overall     Left      Right",
    "DC offset   0.000000  0.000000",
    "Min level   -0.892030 -0.892030",
    "Pk lev dB    -1.00   -1.00",
    "RMS lev dB  -29.43  -29.43",
    "RMS Pk dB   -21.05  -21.05",
  ].join("\n");
  assert.equal(parseRmsDb(stats), -29.43);
  assert.equal(parseRmsDb("no numbers here"), null);
  assert.equal(parseRmsDb(""), null);
  assert.equal(parseRmsDb(null), null);
});
