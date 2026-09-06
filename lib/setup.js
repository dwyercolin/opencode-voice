// First-run setup wizard (/voice): detects nemo-speech and configures it,
// installing it in the background when missing. Installs run detached, show
// a loading bar in toasts, and notify when done.

import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

import { hasBinary, invalidateBinaryCache } from "./engines.js";
import { resolveOpencodeCleanup } from "./cleanup.js";

const NEMO_INSTALL_CMD =
  "curl -fsSL https://github.com/NVIDIA/NeMo-Speech.cpp/raw/main/scripts/install.sh | sh";

/**
 * Indeterminate "loading" bar for installs without percentages: a filled cell
 * cycles left to right, e.g. spinnerBar(3) -> "░░░█░░░░░░".
 */
export function spinnerBar(tick, width = 10) {
  const pos = Math.max(0, tick % width);
  return `${"░".repeat(pos)}█${"░".repeat(width - 1 - pos)}`;
}

/** Render a compact ASCII progress bar, e.g. progressBar(47) -> "█████░░░░░░". */
export function progressBar(percent, width = 10) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((clamped / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

/**
 * Pure recommendation: which nemo-speech model fits this user. Parakeet TDT
 * leads the Open ASR leaderboard for English; Nemotron covers other languages.
 */
export function recommendNemoModel(language) {
  return language === "en" ? "parakeet-tdt" : "";
}

export function createVoiceSetup(ctx) {
  const { api, kv, client, logger, opts, toast, talkKey, setVoiceMode } = ctx;

  function dialog(title, options) {
    api.ui.dialog.replace(() => api.ui.DialogSelect({ title, options }));
  }

  // ---- Background installers ----
  //
  // Installs run detached from the wizard: the dialog closes immediately so
  // the user keeps working, progress lands in toasts (percent for downloads),
  // and completion notifies. /voice shows live status while one is running.

  let installState = null; // { label, proc, startedAt, lastPercent }

  function runInstall(label, command, { onDone, parseProgress = false } = {}) {
    if (installState) {
      toast("Another install is already running", "warning");
      return;
    }
    api.ui.dialog.clear();
    const startedAt = Date.now();
    toast(`${label} | running in background, keep working`, "info", 5000);
    logger?.log("STT", `Setup install started: ${label}`, "debug");
    const proc = spawn("bash", ["-c", command], {
      env: {
        ...process.env,
        PATH: `${path.join(os.homedir(), ".local", "bin")}:${process.env.PATH}`,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    installState = { label, proc, startedAt, lastPercent: null };

    let lastToastAt = 0;
    proc.stderr.on("data", (chunk) => {
      if (!parseProgress) return;
      const m = /(\d{1,3}(?:\.\d)?)%/.exec(chunk.toString());
      if (m) installState.lastPercent = Number.parseFloat(m[1]);
      const now = Date.now();
      if (m && now - lastToastAt > 1200) {
        lastToastAt = now;
        toast(
          `${label} | ${progressBar(installState.lastPercent)} | ${Math.round(installState.lastPercent)}%`,
          "info",
          3000,
        );
      }
    });

    // Indeterminate loading bar for installs that report no percentages.
    let spinTick = 0;
    const spinner = setInterval(() => {
      if (!installState || installState.proc !== proc) {
        clearInterval(spinner);
        return;
      }
      if (installState.lastPercent != null) {
        clearInterval(spinner);
        return;
      }
      const now = Date.now();
      if (now - lastToastAt > 900) {
        lastToastAt = now;
        const secs = Math.round((now - startedAt) / 1000);
        toast(`${label} | ${spinnerBar(spinTick++)} | ${secs}s`, "info", 2000);
      }
    }, 900);

    const finish = (ok, code) => {
      clearInterval(spinner);
      installState = null;
      invalidateBinaryCache();
      const secs = Math.round((Date.now() - startedAt) / 1000);
      if (ok) {
        toast(`${label} | complete (${secs}s) | run /voice to finish setup`, "success", 10000);
      } else {
        toast(`${label} | failed (exit ${code}) | see README for manual steps`, "error", 10000);
      }
      onDone?.(ok);
    };
    proc.on("error", (err) => {
      clearInterval(spinner);
      installState = null;
      toast(`${label} failed: ${err.message}`, "error", 10000);
      onDone?.(false);
    });
    proc.on("exit", (code) => finish(code === 0, code));
  }

  function installNemo(onDone) {
    runInstall("Installing nemo-speech", NEMO_INSTALL_CMD, { onDone, parseProgress: true });
  }

  function installStatusDialog() {
    const secs = Math.round((Date.now() - installState.startedAt) / 1000);
    const pct =
      installState.lastPercent != null
        ? ` | ${progressBar(installState.lastPercent)} | ${Math.round(installState.lastPercent)}%`
        : "";
    dialog(`${installState.label}${pct} | ${secs}s`, [
      {
        title: "Keep it running - I'll keep working",
        value: "back",
        onSelect() {
          api.ui.dialog.clear();
        },
      },
      {
        title: "Cancel install",
        value: "cancel",
        onSelect() {
          try {
            installState.proc.kill("SIGKILL");
          } catch {}
          api.ui.dialog.clear();
        },
      },
    ]);
  }

  // ---- Wizard flows ----

  function stepCleanup() {
    if (opts?.endpoint) {
      dialog("Setup | text cleanup", [
        {
          title: `Use configured endpoint (${opts.model || "tui.json"}) ›`,
          value: "configured",
          onSelect() {
            stepMode();
          },
        },
      ]);
      return;
    }
    resolveOpencodeCleanup(client, logger).then((resolved) => {
      const options = [];
      if (resolved?.endpoint && resolved.candidates.length > 0) {
        for (const [i, candidate] of resolved.candidates.slice(0, 3).entries()) {
          options.push({
            title: `Use my opencode models | ${candidate}${i === 0 ? " (recommended)" : ""} ›`,
            value: `model-${i}`,
            onSelect() {
              kv.set("cleanup.mode", "opencode");
              kv.set("cleanup.model", candidate);
              stepMode();
            },
          });
        }
      }
      options.push({
        title: resolved?.endpoint
          ? "Skip cleanup | keep raw dictation"
          : "Skip cleanup | no opencode server found",
        value: "skip",
        onSelect() {
          kv.set("cleanup.mode", "skip");
          stepMode();
        },
      });
      dialog("Setup | text cleanup", options);
    });
  }

  function stepMode() {
    dialog("Setup | input mode", [
      {
        title: `Hold ${talkKey} to talk (recommended) ›`,
        value: "hold",
        onSelect() {
          setVoiceMode("hold");
          finish();
        },
      },
      {
        title: `Tap ${talkKey} to start, tap again to finish ›`,
        value: "tap",
        onSelect() {
          setVoiceMode("tap");
          finish();
        },
      },
    ]);
  }

  function finish() {
    kv.set("voice.setupDone", true);
    api.ui.dialog.clear();
    toast(`Setup complete | hold ${talkKey} and talk`, "success");
  }

  // Simple: detect, use, done - two taps when everything works.

  async function runSimple() {
    const nemoOk = hasBinary("nemo-speech");
    const whisperOk = hasBinary("whisper-cli");

    if (!nemoOk && !whisperOk) {
      dialog("Setup | no engine found", [
        {
          title: "Install nemo-speech | tiny model, any computer ›",
          value: "install",
          onSelect() {
            installNemo((ok) => {
              if (ok && hasBinary("nemo-speech")) {
                kv.set("stt.engine", "nemo");
                kv.set("stt.nemo.model", "parakeet-tdt");
              }
            });
          },
        },
        ...(opts?.sttEndpoint
          ? [
              {
                title: "Use transcription API (configured) ›",
                value: "api",
                onSelect() {
                  kv.set("stt.engine", "api");
                  stepCleanup();
                },
              },
            ]
          : []),
        {
          title: "Cancel",
          value: "cancel",
          onSelect() {
            api.ui.dialog.clear();
          },
        },
      ]);
      return;
    }

    kv.set("stt.engine", nemoOk ? "nemo" : "whisper");
    if (nemoOk) kv.set("stt.nemo.model", "parakeet-tdt");
    stepCleanup();
  }

  // ---- Entry point ----

  function run() {
    if (installState) {
      installStatusDialog();
      return;
    }
    runSimple();
  }

  return { run };
}
