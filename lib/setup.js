// First-run setup wizard (/voice): makes sure nemo-speech is available, picks
// the LLM that cleans up dictation, and picks the input mode. Installs run
// detached, show a loading bar in toasts, and notify when done.

import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

import { hasBinary, invalidateBinaryCache } from "./engines.js";
import { createMenu, shortLabel } from "./menu.js";
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

/**
 * How old a measurement is, for menu titles: "just tested", "tested 40s ago",
 * "tested 3m ago". Probe results are cached, so the picker has to say whether
 * the latencies on screen were measured now or minutes ago.
 */
export function formatAge(ms) {
  const secs = Math.max(0, Math.round(Number(ms) / 1000) || 0);
  if (secs < 10) return "just tested";
  if (secs < 90) return `tested ${secs}s ago`;
  return `tested ${Math.round(secs / 60)}m ago`;
}

export function createVoiceSetup(ctx) {
  const { api, kv, client, logger, opts, toast, talkKey, setVoiceMode } = ctx;

  // Every screen here goes through the shared menu helper: it widens the
  // dialog past the 60-column default and clips each row to fit one line.
  const menu = createMenu(api);

  function dialog(title, options) {
    menu({ title, options });
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
    toast(`${label} · running in background, keep working`, "info", 5000);
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
          `${label} · ${progressBar(installState.lastPercent)} ${Math.round(installState.lastPercent)}%`,
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
        toast(`${label} · ${spinnerBar(spinTick++)} ${secs}s`, "info", 2000);
      }
    }, 900);

    const finishInstall = (ok, code) => {
      clearInterval(spinner);
      installState = null;
      invalidateBinaryCache();
      const secs = Math.round((Date.now() - startedAt) / 1000);
      if (ok) {
        toast(`${label} · complete in ${secs}s · run /voice to finish setup`, "success", 10000);
      } else {
        toast(`${label} · failed (exit ${code}) · see README for manual steps`, "error", 10000);
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
    const pct = installState.lastPercent;
    const progress = pct != null ? `${progressBar(pct)} ${Math.round(pct)}%` : "working";
    dialog(`${installState.label} · ${progress} · ${secs}s`, [
      {
        title: "Keep it running",
        description: "closes this screen, install continues in the background",
        value: "back",
        onSelect() {
          api.ui.dialog.clear();
        },
      },
      {
        title: "Cancel install",
        description: "stops the download",
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
    dialog("Setup · nemo-speech is not installed", [
      {
        title: "Install it for me",
        description: "downloads in the background, keep working",
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
        title: "Not now",
        description: "see the README for manual install steps",
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
          title: shortLabel(m.id),
          // The name repeats the id on most providers; only show it when it
          // adds something, and tag small models in the all-models view.
          description: m.name && !m.id.endsWith(m.name) ? m.name : undefined,
          footer: !smallOnly && m.small ? "small" : undefined,
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
            title: smallOnly ? "Show all models" : "Show small models only",
            description: smallOnly
              ? `${models.length - small.length} more, not tagged small`
              : "recommended for cleanup",
            value: "toggle",
            onSelect() {
              showCleanupModelDialog({ next, back, all: !all });
            },
          });
        }
        if (back) {
          options.push({
            title: "Back",
            value: "back",
            onSelect() {
              back();
            },
          });
        }
        menu({
          title: smallOnly
            ? `Cleanup model · ${small.length} small models (fast and cheap)`
            : `Cleanup model · all ${models.length} models`,
          options,
          // Long list of ids: worth both the extra width and the search box.
          size: "xlarge",
          filter: true,
          placeholder: "Search models…",
          current: kv.get("cleanup.model", ""),
        });
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
  // by homophone fixes then latency, best match on top. Recent results are
  // reused so re-opening the list is instant - the title says how old they
  // are, and the "Test again" row re-probes everything on demand.
  const PROBE_CACHE_MS = 5 * 60_000;
  const probeCache = new Map(); // model id -> { result, at }

  async function runCleanupAutoPick({ next, back, fresh = false } = {}) {
    const baseUrl = await discoverHostServerUrl();
    const models = await listCleanupModels(client, logger);
    const small = models.filter((m) => m.small).slice(0, 6);
    if (!baseUrl || small.length === 0) {
      toast("No small models found to test", "warning");
      return;
    }
    const now = Date.now();
    // Reopening the picker reuses recent results rather than spending another
    // round of requests; "Test again" forces every model to be probed now.
    const stale = fresh
      ? small
      : small.filter((m) => {
          const hit = probeCache.get(m.id);
          return !hit || now - hit.at > PROBE_CACHE_MS;
        });
    if (stale.length > 0) {
      toast(`Testing ${stale.length} small model${stale.length === 1 ? "" : "s"}...`);
      for (const result of await probeCleanupModels(baseUrl, stale, logger)) {
        // Cache only working probes. A failed one (server hiccup, missing
        // auth) must be retried on the next open, not served from cache as
        // an authoritative "model does not respond" for five minutes.
        if (result.ok) probeCache.set(result.id, { result, at: now });
      }
    }
    const results = rankProbeResults(
      small.map((m) => ({ id: m.id, name: m.name, ...probeCache.get(m.id)?.result })),
    );
    const working = results.filter((r) => r.ok);
    if (working.length === 0) {
      // "None responded" is useless without a reason: HTTP 401/403 means the
      // provider needs (re)auth in opencode, HTTP 404 means the catalog lists
      // a model the host server does not serve, timeouts mean a slow or
      // unreachable endpoint, "fetch failed" usually means stale server
      // discovery - restart the TUI session.
      const counts = new Map();
      for (const r of results) {
        if (r.error) counts.set(r.error, (counts.get(r.error) ?? 0) + 1);
      }
      const [topError, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
      toast(
        `None of the ${small.length} tested models responded${topError ? ` · ${topError}${topCount > 1 ? ` (x${topCount})` : ""}` : ""}`,
        "error",
        10000,
      );
      logger?.log(
        "STT",
        `Auto-pick probes all failed: ${results.map((r) => `${r.id}: ${r.error ?? "unknown"}`).join("; ")}`,
        "warn",
      );
      return;
    }
    const options = working.map((r, i) => ({
      title: shortLabel(r.id),
      description: i === 0 ? "best match" : undefined,
      footer: `${r.fixes}/3 fixes · ${(r.ms / 1000).toFixed(1)}s`,
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
    options.push({
      title: "Test again",
      description: "probe every model again instead of reusing these results",
      value: "retest",
      onSelect() {
        runCleanupAutoPick({ next, back, fresh: true }).catch((err) => {
          logger?.log("STT", `Auto-pick failed: ${err.message}`, "warn");
          toast("Auto-pick failed", "error");
        });
      },
    });
    if (back) {
      options.push({
        title: "Back",
        value: "back",
        onSelect() {
          back();
        },
      });
    }
    // Say how old the numbers are: cached results are the common case on a
    // second visit, and stale latencies would otherwise look like fresh ones.
    const oldest = Math.min(...small.map((m) => probeCache.get(m.id)?.at ?? now));
    menu({
      title: `Cleanup model · ${formatAge(Date.now() - oldest)} · ${working.length}/${small.length} responded`,
      options,
      // Ids plus two metrics per row need more than the default width.
      size: "xlarge",
      current: kv.get("cleanup.model", ""),
    });
  }

  // Step 1: which LLM cleans up the raw transcript. Also reachable on its own
  // from the /voice settings hub, hence the configurable title and follow-up.
  function stepCleanup({ title = "Setup 1/2 · clean up dictation with", next = stepMode } = {}) {
    if (opts?.endpoint) {
      // tui.json already pins an endpoint - nothing to ask, skip ahead.
      next();
      return;
    }
    resolveOpencodeCleanup(client, logger).then((resolved) => {
      const candidates = resolved?.endpoint ? (resolved.candidates ?? []) : [];
      const options = candidates.slice(0, 3).map((candidate, i) => ({
        title: shortLabel(candidate),
        description: i === 0 ? "recommended · your opencode small model" : undefined,
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
          title: "Test and auto-pick",
          description: "probes your small models live, ranks the best",
          value: "autopick",
          onSelect() {
            runCleanupAutoPick({ next, back: () => stepCleanup({ title, next }) }).catch((err) => {
              logger?.log("STT", `Auto-pick failed: ${err.message}`, "warn");
              toast("Auto-pick failed", "error");
            });
          },
        });
        options.push({
          title: "Browse all models",
          description: "like /models, used only for cleanup",
          value: "browse",
          onSelect() {
            showCleanupModelDialog({ next, back: () => stepCleanup({ title, next }) });
          },
        });
      }
      options.push({
        title: "Skip cleanup",
        description: resolved?.endpoint ? "keep raw dictation" : "no opencode server found",
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
    dialog("Setup 2/2 · input mode", [
      {
        // Whether the text is then submitted is the separate auto-submit
        // setting, so these rows stop at "transcribe" and do not promise a send.
        title: `Push to talk · hold ${talkKey}`,
        description: "recommended · release to stop and transcribe",
        value: "hold",
        onSelect() {
          finish("hold");
        },
      },
      {
        title: `Tap to toggle · tap ${talkKey}`,
        description: "tap again to stop and transcribe",
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
        ? `Setup complete · tap ${talkKey}, talk, tap again`
        : `Setup complete · hold ${talkKey} and talk`,
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
