import assert from "node:assert/strict";
import test from "node:test";

import { createHoldDetector } from "../lib/voice-mode.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("single press without repeat fires onTap", async () => {
  let taps = 0;
  let holds = 0;
  let ends = 0;
  const detector = createHoldDetector({
    onTap: () => taps++,
    onHoldStart: () => holds++,
    onHoldEnd: () => ends++,
    armMs: 30,
    releaseMs: 60,
  });

  detector.press();
  assert.equal(detector.state, "armed");
  await sleep(80);
  assert.equal(detector.state, "idle");
  assert.equal(taps, 1);
  assert.equal(holds, 0);
  assert.equal(ends, 0);
});

test("press followed by repeat confirms a hold and starts listening", async () => {
  let holds = 0;
  const detector = createHoldDetector({
    onHoldStart: () => holds++,
    armMs: 30,
    releaseMs: 60,
  });

  detector.press();
  await sleep(10);
  detector.press();
  assert.equal(detector.state, "holding");
  assert.equal(holds, 1);
  detector.reset();
});

test("release is inferred when repeats stop arriving", async () => {
  let ends = 0;
  const detector = createHoldDetector({
    onHoldEnd: () => ends++,
    armMs: 30,
    releaseMs: 80,
  });

  detector.press();
  detector.press();
  await sleep(200);
  assert.equal(detector.state, "idle");
  assert.equal(ends, 1);
});

test("ongoing repeats keep the hold alive", async () => {
  let ends = 0;
  const detector = createHoldDetector({
    onHoldEnd: () => ends++,
    armMs: 30,
    releaseMs: 80,
  });

  detector.press();
  detector.press();
  for (let i = 0; i < 5; i++) {
    await sleep(40);
    detector.press();
  }
  assert.equal(detector.state, "holding");
  assert.equal(ends, 0);
  await sleep(200);
  assert.equal(ends, 1);
  assert.equal(detector.state, "idle");
});

test("reset cancels armed and holding states without callbacks", async () => {
  let taps = 0;
  let ends = 0;
  const detector = createHoldDetector({
    onTap: () => taps++,
    onHoldEnd: () => ends++,
    armMs: 30,
    releaseMs: 80,
  });

  detector.press();
  detector.reset();
  await sleep(120);
  assert.equal(taps, 0);
  assert.equal(detector.state, "idle");

  detector.press();
  detector.press();
  detector.reset();
  await sleep(200);
  assert.equal(ends, 0);
  assert.equal(detector.state, "idle");
});

test("detector supports back-to-back hold cycles", async () => {
  let holds = 0;
  let ends = 0;
  const detector = createHoldDetector({
    onHoldStart: () => holds++,
    onHoldEnd: () => ends++,
    armMs: 20,
    releaseMs: 60,
  });

  detector.press();
  detector.press();
  await sleep(150);
  detector.press();
  detector.press();
  await sleep(150);

  assert.equal(holds, 2);
  assert.equal(ends, 2);
  assert.equal(detector.state, "idle");
});
