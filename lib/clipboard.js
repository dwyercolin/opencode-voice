// Clipboard write for dialog rows like "copy the install command". The
// renderer's OSC 52 support is tried first - it works over SSH and needs no
// tools - then system paste tools for terminals the renderer did not cover.

import { spawn } from "node:child_process";

import { hasBinary } from "./engines.js";

/** OSC 52 escape sequence setting the clipboard; unsupported terminals ignore it. */
export function osc52(text) {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

const PASTE_TOOLS = {
  linux: [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]],
  darwin: [["pbcopy"]],
};

function runTool(bin, args, text) {
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ["pipe", "ignore", "ignore"] });
    proc.on("error", () => resolve(false));
    proc.stdin.on("error", () => resolve(false));
    proc.stdin.end(text, () => {
      proc.on("close", (code) => resolve(code === 0));
    });
  });
}

/**
 * Hand `text` to the system clipboard, trying the cheapest path first:
 * renderer OSC 52, then a raw OSC 52 write when the renderer exposes one but
 * not its capability-checked wrapper, then wl-copy/xclip/xsel/pbcopy. Resolves
 * false when nothing could accept the text - the caller must keep it visible
 * on screen so the user can copy it manually.
 */
export async function copyToClipboard(api, text, deps = {}) {
  const renderer = api?.renderer;
  if (typeof renderer?.copyToClipboardOSC52 === "function") {
    try {
      if (renderer.copyToClipboardOSC52(text)) return true;
    } catch {}
  } else if (typeof renderer?.writeOut === "function") {
    // Only when the renderer has no capability-checked wrapper of its own:
    // a plain write into a terminal that said "unsupported" would be noise.
    try {
      renderer.writeOut(osc52(text));
      return true;
    } catch {}
  }
  const check = deps.hasBinary ?? hasBinary;
  for (const [bin, ...args] of PASTE_TOOLS[deps.platform ?? process.platform] ?? []) {
    if (!check(bin)) continue;
    if (await (deps.runTool ?? runTool)(bin, args, text)) return true;
  }
  return false;
}
