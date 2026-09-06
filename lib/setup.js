// First-run setup wizard (/voice): Simple picks sensible defaults after
// detecting the environment; Advanced asks about language and hardware and
// recommends an engine + model accordingly. Can install nemo-speech and
// download whisper models directly.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

import { WHISPER_MODELS, hasBinary, invalidateBinaryCache } from "./engines.js";
import { resolveOpencodeCleanup } from "./cleanup.js";

const NEMO_INSTALL_CMD =
  "curl -fsSL https://github.com/NVIDIA/NeMo-Speech.cpp/raw/main/scripts/install.sh | sh";

/** Render a compact ASCII progress bar, e.g. progressBar(47) -> "█████░░░░░░". */
export function progressBar(percent, width = 10) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((clamped / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

/**
 * Pure recommendation: which engine/model fits this user best.
 * English speakers get Parakeet (best accuracy, tiny model, runs anywhere);
 * other languages get Nemotron (multilingual) or whisper.cpp. The API is the
 * fallback when nothing local is possible.
 */
export function recommendEngine({
  language,
  hardware,
  nemoInstalled,
  whisperInstalled,
  apiConfigured,
}) {
  const options = [];
  if (nemoInstalled) {
    options.push({
      engine: "nemo",
      nemoModel: language === "en" ? "parakeet-tdt" : "",
      title:
        language === "en"
          ? "nemo-speech - Parakeet (best English accuracy, tiny model)"
          : "nemo-speech - Nemotron (multilingual)",
    });
  }
  if (whisperInstalled) {
    const small = hardware === "modest";
    options.push({
      engine: "whisper",
      whisperModel: small ? "base" : "large-v3-turbo-q5_0",
      title: small
        ? "whisper.cpp - base (fast on modest hardware, multilingual)"
        : "whisper.cpp - large v3 turbo (accurate, multilingual)",
    });
  }
  if (apiConfigured) {
    options.push({
      engine: "api",
      title: "Transcription API (no local compute needed)",
    });
  }
  const first = options[0] || null;
  return { recommendation: first, options };
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

    const finish = (ok, code) => {
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
      installState = null;
      toast(`${label} failed: ${err.message}`, "error", 10000);
      onDone?.(false);
    });
    proc.on("exit", (code) => finish(code === 0, code));
  }

  function installNemo(onDone) {
    runInstall("Installing nemo-speech", NEMO_INSTALL_CMD, { onDone });
  }

  function downloadWhisperModel(modelKey, onDone) {
    const dir = path.join(os.homedir(), ".local", "share", "whisper-cpp");
    const file = WHISPER_MODELS[modelKey]?.file;
    if (!file) {
      onDone?.(false);
      return;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
    const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`;
    runInstall(
      "Downloading Whisper",
      `curl --progress-bar -sL -o '${path.join(dir, file)}' '${url}'`,
      {
        onDone,
        parseProgress: true,
      },
    );
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
        title: resolved?.endpoint ? "Skip cleanup | keep raw dictation" : "Skip cleanup | no opencode server found",
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
        title: `Tap ${talkKey} to start, tap again to send ›`,
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

  // Advanced: language, hardware, engine, model size.

  function runAdvanced() {
    dialog("Setup | your language", [
      {
        title: "English ›",
        value: "en",
        onSelect() {
          advancedHardware("en");
        },
      },
      {
        title: "Another language (or mixed) ›",
        value: "multi",
        onSelect() {
          advancedHardware("multi");
        },
      },
    ]);
  }

  function advancedHardware(language) {
    dialog("Setup | this computer", [
      {
        title: "Modern | built in the last ~6 years ›",
        value: "modern",
        onSelect() {
          advancedEngine(language, "modern");
        },
      },
      {
        title: "Modest | older or low-spec ›",
        value: "modest",
        onSelect() {
          advancedEngine(language, "modest");
        },
      },
    ]);
  }

  function advancedEngine(language, hardware) {
    const nemoOk = hasBinary("nemo-speech");
    const whisperOk = hasBinary("whisper-cli");
    const { recommendation } = recommendEngine({
      language,
      hardware,
      nemoInstalled: nemoOk,
      whisperInstalled: whisperOk,
      apiConfigured: Boolean(opts?.sttEndpoint),
    });
    const mark = (opt) =>
      recommendation && opt === recommendation.engine ? " (recommended)" : "";

    const options = [];
    if (nemoOk) {
      options.push({
        title:
          language === "en"
            ? `nemo-speech | Parakeet | best English accuracy${mark("nemo")} ›`
            : `nemo-speech | Nemotron | multilingual${mark("nemo")} ›`,
        value: "nemo",
        onSelect() {
          kv.set("stt.engine", "nemo");
          kv.set("stt.nemo.model", language === "en" ? "parakeet-tdt" : "");
          stepCleanup();
        },
      });
    } else {
      options.push({
        title: "Install nemo-speech | tiny model, any computer ›",
        value: "install-nemo",
        onSelect() {
          const nemoModel = language === "en" ? "parakeet-tdt" : "";
          installNemo((ok) => {
            if (ok && hasBinary("nemo-speech")) {
              kv.set("stt.engine", "nemo");
              kv.set("stt.nemo.model", nemoModel);
            }
          });
        },
      });
    }

    if (whisperOk) {
      options.push({
        title: `whisper.cpp | pick model size${mark("whisper")} ›`,
        value: "whisper",
        onSelect() {
          advancedWhisperModel(language, hardware);
        },
      });
    } else {
      options.push({
        title: "Install whisper.cpp | build from source ›",
        value: "install-whisper",
        onSelect() {
          installWhisper((ok) => {
            if (ok && hasBinary("whisper-cli")) {
              advancedWhisperModel(language, hardware);
            }
          });
        },
      });
    }

    if (opts?.sttEndpoint) {
      options.push({
        title: `Transcription API | no local compute${mark("api")} ›`,
        value: "api",
        onSelect() {
          kv.set("stt.engine", "api");
          stepCleanup();
        },
      });
    }

    options.push({
      title: "Back",
      value: "back",
      onSelect() {
        advancedHardware(language);
      },
    });
    dialog("Setup | engine", options);
  }

  function advancedWhisperModel(language, hardware) {
    const recommended =
      hardware === "modest" ? "base" : "large-v3-turbo-q5_0";
    const entries = Object.entries(WHISPER_MODELS).filter(([key]) =>
      language === "en" ? true : !key.endsWith(".en"),
    );
    const options = entries.map(([key, v]) => ({
      title: `${v.label} | ${v.size}${key === recommended ? " (recommended)" : ""}${
        fs.existsSync(
          path.join(os.homedir(), ".local", "share", "whisper-cpp", v.file),
        )
          ? " | downloaded"
          : ""
      } ›`,
      value: key,
      onSelect() {
        kv.set("stt.engine", "whisper");
        kv.set("stt.model", key);
        const modelFile = path.join(os.homedir(), ".local", "share", "whisper-cpp", v.file);
        if (!fs.existsSync(modelFile)) {
          downloadWhisperModel(key, (ok) => {
            if (!ok) kv.set("stt.model", null);
          });
          return;
        }
        stepCleanup();
      },
    }));
    options.push({
      title: "Back",
      value: "back",
      onSelect() {
        advancedEngine(language, hardware);
      },
    });
    dialog("Setup | whisper model", options);
  }

  // ---- Entry point ----

  function run() {
    if (installState) {
      installStatusDialog();
      return;
    }
    dialog("Voice setup", [
      {
        title: "Simple | detect everything (recommended) ›",
        value: "simple",
        onSelect() {
          runSimple();
        },
      },
      {
        title: "Advanced | pick engine & model size ›",
        value: "advanced",
        onSelect() {
          runAdvanced();
        },
      },
      {
        title: "Cancel",
        value: "cancel",
        onSelect() {
          api.ui.dialog.clear();
        },
      },
    ]);
  }

  return { run };
}
