import assert from "node:assert/strict";
import test from "node:test";

import { copyToClipboard, osc52 } from "../lib/clipboard.js";

test("osc52 wraps the text base64-encoded in the clipboard escape", () => {
  assert.equal(
    osc52("sudo apt install sox"),
    `\x1b]52;c;${Buffer.from("sudo apt install sox").toString("base64")}\x07`,
  );
});

test("prefers the renderer's capability-checked OSC 52 writer", async () => {
  let wrote = null;
  const api = { renderer: { copyToClipboardOSC52: (text) => (wrote = text) || true } };
  assert.equal(await copyToClipboard(api, "cmd"), true);
  assert.equal(wrote, "cmd");
});

test("a renderer that declines OSC 52 is not second-guessed with raw writes", async () => {
  const writes = [];
  const api = {
    renderer: {
      copyToClipboardOSC52: () => false,
      writeOut: (s) => writes.push(s),
    },
  };
  // The renderer already checked terminal capabilities; an unsupported
  // terminal would only receive noise.
  assert.equal(await copyToClipboard(api, "cmd"), false);
  assert.deepEqual(writes, []);
});

test("a renderer without the wrapper but with writeOut gets the raw escape", async () => {
  const writes = [];
  const api = { renderer: { writeOut: (s) => writes.push(s) } };
  assert.equal(await copyToClipboard(api, "cmd"), true);
  assert.deepEqual(writes, [osc52("cmd")]);
});

test("without renderer support it uses the first available paste tool", async () => {
  const spawned = [];
  const ok = await copyToClipboard({ renderer: {} }, "cmd", {
    platform: "linux",
    hasBinary: (bin) => bin === "wl-copy" || bin === "xclip",
    runTool: async (bin, args, text) => {
      spawned.push([bin, ...args, text]);
      return bin === "xclip";
    },
  });
  // wl-copy is probed first and fails, xclip is next and succeeds.
  assert.equal(ok, true);
  assert.equal(spawned[0][0], "wl-copy");
  assert.equal(spawned[1][0], "xclip");
  assert.equal(spawned[1][3], "cmd");
});

test("resolves false when no path can accept the text", async () => {
  const api = { renderer: { copyToClipboardOSC52: () => false } };
  const ok = await copyToClipboard(api, "cmd", {
    platform: "linux",
    hasBinary: () => false,
  });
  assert.equal(ok, false);
});
