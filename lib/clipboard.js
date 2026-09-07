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
 * Hand `text` to the system clipboard and report how. System paste tools are
 * tried first because their success is verifiable; OSC 52 is the fallback for
 * SSH and toolless machines, but some terminals silently ignore it, so its
 * "success" is only a send, not a delivery. Resolves false when nothing could
 * accept the text - the caller must keep it visible on screen so the user can
 * copy it manually.
 *
 * @returns {"tool" | "osc52" | false}
 */
export async function copyToClipboard(api, text, deps = {}) {
  const check = deps.hasBinary ?? hasBinary;
  for (const [bin, ...args] of PASTE_TOOLS[deps.platform ?? process.platform] ?? []) {
    if (!check(bin)) continue;
    if (await (deps.runTool ?? runTool)(bin, args, text)) return "tool";
  }
  const renderer = api?.renderer;
  if (typeof renderer?.copyToClipboardOSC52 === "function") {
    try {
      if (renderer.copyToClipboardOSC52(text)) return "osc52";
    } catch {}
  } else if (typeof renderer?.writeOut === "function") {
    // Only when the renderer has no capability-checked wrapper of its own:
    // a plain write into a terminal that said "unsupported" would be noise.
    try {
      renderer.writeOut(osc52(text));
      return "osc52";
    } catch {}
  }
  return false;
}
