// First-run setup wizard (/voice): makes sure nemo-speech is available, picks
// the LLM that cleans up dictation, and picks the input mode. Installs run
// detached, show a loading bar in toasts, and notify when done.

import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

import { hasBinary, invalidateBinaryCache } from "./engines.js";
import {
  discoverHostServerUrl,
  listCleanupModels,
  probeCleanupModels,
  rankProbeResults,
  resolveOpencodeCleanup,
} from "./cleanup.js";

const NEMO_INSTALL_CMD =
  "curl -fsSL https://github.com/NVIDIA/NeMo-Speech.cpp/raw/main/scripts/install.sh | sh";

// Seeded for new users: Parakeet TDT leads the Open ASR leaderboard for
// English one-shot dictation. /stt-model switches to the multilingual default.
const DEFAULT_NEMO_MODEL = "parakeet-tdt";

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

/** Shorten "anthropic/claude-sonnet-4-5" style ids for narrow dialog rows. */
export function shortModelLabel(model, max = 42) {
  const text = String(model || "");
  return text.length <= max ? text : `…${text.slice(text.length - (max - 1))}`;
}

export function createVoiceSetup(ctx) {
  const { api, kv, client, logger, opts, toast, talkKey, setVoiceMode } = ctx;

  function dialog(title, options) {
    api.ui.dialog.replace(() => api.ui.DialogSelect({ title, options }));
  }

  // ---- Background installer ----
  //
  // The install runs detached from the wizard: the dialog closes immediately so
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

    const finishInstall = (ok, code) => {
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
    proc.on("exit", (code) => finishInstall(code === 0, code));
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

  // ---- Wizard steps ----

  // Step 0 (only when the engine is missing): install nemo-speech.
  function stepInstall() {
    dialog("Setup | nemo-speech is not installed", [
      {
        title: "Install it for me | runs in the background ›",
        value: "install",
        onSelect() {
          runInstall("Installing nemo-speech", NEMO_INSTALL_CMD, {
            parseProgress: true,
            onDone(ok) {
              if (ok && hasBinary("nemo-speech")) kv.set("stt.nemo.model", DEFAULT_NEMO_MODEL);
            },
          });
        },
      },
      {
        title: "Not now | see README for manual install",
        value: "cancel",
        onSelect() {
          api.ui.dialog.clear();
        },
      },
    ]);
  }

  // ---- Cleanup model browser ----
  //
  // /models-style picker for the cleanup LLM: every model usable through the
  // host server (auth providers, catalogs, and served models merged), used
  // only for cleaning dictation. Cleanup is one short call per dictation, so
  // it shows ONLY small models by default (name/size/pricing heuristic); a
  // "Show all models" row at the bottom drops the filter for when the
  // heuristic misses something worth using.
  function showCleanupModelDialog({ next, back, all = false } = {}) {
    listCleanupModels(client, logger)
      .then((models) => {
        if (models.length === 0) {
          toast("No models found for cleanup - log into a provider first", "warning");
          return;
        }
        const small = models.filter((m) => m.small);
        // Nothing tagged small: fall back to the full list, not an empty picker.
        const smallOnly = !all && small.length > 0;
        const rows = smallOnly ? small : models;
        const options = rows.map((m) => ({
          title: m.small ? `${m.id} | ${m.name} | small` : `${m.id} | ${m.name}`,
          value: m.id,
          onSelect() {
            kv.set("cleanup.mode", "opencode");
            kv.set("cleanup.model", m.id);
            toast(`Cleanup model: ${m.id}`);
            if (next) {
              next();
              return;
            }
            api.ui.dialog.clear();
          },
        }));
        if (small.length > 0) {
          options.push({
            title: smallOnly
              ? `Show all models › | ${models.length - small.length} not tagged small`
              : "Only small models › | recommended for cleanup",
            value: "toggle",
            onSelect() {
              showCleanupModelDialog({ next, back, all: !all });
            },
          });
        }
        if (back) {
          options.push({
            title: "‹ Back",
            value: "back",
            onSelect() {
              back();
            },
          });
        }
        api.ui.dialog.replace(() =>
          api.ui.DialogSelect({
            title: smallOnly
              ? "Cleanup model | small models only (fast + cheap)"
              : "Cleanup model | all models",
            current: kv.get("cleanup.model", ""),
            options,
          }),
        );
      })
      .catch((err) => {
        logger?.log("STT", `Model list failed: ${err.message}`, "warn");
        toast("Could not load models", "error");
      });
  }

  // ---- Cleanup model auto-pick ----
  //
  // Availability lists guess; the probe knows. Fires one tiny cleanup-shaped
  // request at each small model in parallel, then shows the survivors ranked
  // by homophone fixes then latency, best match on top. Results are cached
  // briefly so re-opening the list is instant.
  const PROBE_CACHE_MS = 5 * 60_000;
  const probeCache = new Map(); // model id -> { result, at }

  async function runCleanupAutoPick({ next, back } = {}) {
    const baseUrl = await discoverHostServerUrl();
    const models = await listCleanupModels(client, logger);
    const small = models.filter((m) => m.small).slice(0, 6);
    if (!baseUrl || small.length === 0) {
      toast("No small models found to test", "warning");
      return;
    }
    toast(`Testing ${small.length} small models...`);
    const now = Date.now();
    const stale = small.filter((m) => {
      const hit = probeCache.get(m.id);
      return !hit || now - hit.at > PROBE_CACHE_MS;
    });
    if (stale.length > 0) {
      for (const result of await probeCleanupModels(baseUrl, stale, logger)) {
        probeCache.set(result.id, { result, at: now });
      }
    }
    const results = rankProbeResults(
      small.map((m) => ({ id: m.id, name: m.name, ...probeCache.get(m.id)?.result })),
    );
    const working = results.filter((r) => r.ok);
    if (working.length === 0) {
      toast(`None of the ${small.length} tested models responded`, "error");
      return;
    }
    const options = working.map((r, i) => ({
      title: `${i === 0 ? "Best match | " : ""}${r.id} | ${(r.ms / 1000).toFixed(1)}s | ${r.fixes}/3 fixes`,
      value: r.id,
      onSelect() {
        kv.set("cleanup.mode", "opencode");
        kv.set("cleanup.model", r.id);
        toast(`Cleanup model: ${r.id} (${(r.ms / 1000).toFixed(1)}s, ${r.fixes}/3 fixes)`);
        if (next) {
          next();
          return;
        }
        api.ui.dialog.clear();
      },
    }));
    if (back) {
      options.push({
        title: "‹ Back",
        value: "back",
        onSelect() {
          back();
        },
      });
    }
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title: `Cleanup model | tested live, best first (${working.length}/${small.length} responded)`,
        current: kv.get("cleanup.model", ""),
        options,
      }),
    );
  }

  // Step 1: which LLM cleans up the raw transcript. Also reachable on its own
  // from the /voice settings hub, hence the configurable title and follow-up.
  function stepCleanup({ title = "Setup 1/2 | clean up dictation with", next = stepMode } = {}) {
    if (opts?.endpoint) {
      // tui.json already pins an endpoint - nothing to ask, skip ahead.
      next();
      return;
    }
    resolveOpencodeCleanup(client, logger).then((resolved) => {
      const candidates = resolved?.endpoint ? (resolved.candidates ?? []) : [];
      const options = candidates.slice(0, 3).map((candidate, i) => ({
        title:
          i === 0
            ? `Clean up with ${shortModelLabel(candidate)} (recommended) ›`
            : `Use ${shortModelLabel(candidate)} instead ›`,
        value: `model-${i}`,
        onSelect() {
          kv.set("cleanup.mode", "opencode");
          kv.set("cleanup.model", candidate);
          next();
        },
      }));
      // The browse/auto-pick paths run cleanup against the host server, so
      // only offer them when that endpoint was actually discovered.
      if (resolved?.endpoint) {
        options.push({
          title: "Test & auto-pick › | probes your small models live, ranks the best",
          value: "autopick",
          onSelect() {
            runCleanupAutoPick({ next, back: () => stepCleanup({ title, next }) }).catch((err) => {
              logger?.log("STT", `Auto-pick failed: ${err.message}`, "warn");
              toast("Auto-pick failed", "error");
            });
          },
        });
        options.push({
          title: "Browse all models › | like /models, used only for cleanup",
          value: "browse",
          onSelect() {
            showCleanupModelDialog({ next, back: () => stepCleanup({ title, next }) });
          },
        });
      }
      options.push({
        title: resolved?.endpoint
          ? "Skip cleanup | keep raw dictation"
          : "Skip cleanup | no opencode server found",
        value: "skip",
        onSelect() {
          kv.set("cleanup.mode", "skip");
          next();
        },
      });
      dialog(title, options);
    });
  }

  // Step 2: how the talk key behaves.
  function stepMode() {
    dialog("Setup 2/2 | input mode", [
      {
        title: `Hold ${talkKey} to talk (recommended) ›`,
        value: "hold",
        onSelect() {
          finish("hold");
        },
      },
      {
        title: `Tap ${talkKey} to start, tap again to finish ›`,
        value: "tap",
        onSelect() {
          finish("tap");
        },
      },
    ]);
  }

  function finish(mode) {
    setVoiceMode(mode, { silent: true });
    kv.set("voice.setupDone", true);
    api.ui.dialog.clear();
    toast(
      mode === "tap"
        ? `Setup complete | tap ${talkKey}, talk, tap again`
        : `Setup complete | hold ${talkKey} and talk`,
      "success",
    );
  }

  // ---- Entry point ----

  function run() {
    if (installState) {
      installStatusDialog();
      return;
    }
    if (!hasBinary("nemo-speech")) {
      stepInstall();
      return;
    }
    if (!kv.get("stt.nemo.model")) kv.set("stt.nemo.model", DEFAULT_NEMO_MODEL);
    stepCleanup();
  }

  return {
    run,
    // Re-pick the cleanup model on its own, from the /voice settings hub.
    chooseCleanup: (o) => stepCleanup(o),
    installRunning: () => installState != null,
  };
}
