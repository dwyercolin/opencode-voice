// First-run setup wizard (/voice): makes sure nemo-speech is available, picks
// the LLM that cleans up dictation, and picks the input mode. Installs and
// model downloads run detached, several at a time, and report progress in a
// panel toast that lists one line per job.

import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

import {
  NEMO_MODELS,
  hasBinary,
  hasVerifiedNemoModel,
  invalidateBinaryCache,
  nemoModelRepo,
  nemoModelState,
  normalizeNemoModel,
  parseNemoDownloadTotal,
  soxInstallCommand,
} from "./engines.js";
import { copyToClipboard } from "./clipboard.js";
import { addBackRow, createMenu, shortLabel } from "./menu.js";
import {
  listCleanupModels,
  probeCleanupModels,
  rankProbeResults,
  resolveOpencodeCleanup,
  resolveTransport,
} from "./cleanup.js";

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

/** Download sizes for humans: 1.1 GB, 703 MB. */
export function formatBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/**
 * One job as one line of the progress panel. `labelWidth` pads the names so
 * the bars line up in a column when several jobs are listed together.
 */
export function jobLine(job, now = Date.now(), labelWidth = 0) {
  const label = String(job.label).padEnd(labelWidth);
  const secs = Math.max(0, Math.round(((job.finishedAt ?? now) - job.startedAt) / 1000));
  // `detail` is whatever the job counts in its own units ("3/8 answered" for
  // the cleanup probe); downloads count bytes instead.
  const detail = job.detail
    ? ` · ${job.detail}`
    : job.totalBytes
      ? ` · ${formatBytes(job.totalBytes)}`
      : "";
  if (job.state === "done") return `${label}  done${detail} · ${secs}s`;
  if (job.state === "failed") return `${label}  failed · ${job.error ?? "see README"}`;
  // A job with no percentage is one whose command reports no size (the
  // installer); the moving cell says it is alive without inventing progress.
  if (job.percent == null) return `${label}  ${spinnerBar(job.tick ?? 0)} ${secs}s${detail}`;
  return `${label}  ${progressBar(job.percent)} ${Math.round(job.percent)}%${detail}`;
}

/**
 * Title of the screen that stands in for the cleanup menu while the probe is
 * running, and of the screen a second press lands on. It counts answers
 * rather than saying "working": the probe is one real request per model and
 * the only honest question the user has is how many are left.
 */
export function probeTestingTitle(run, now = Date.now()) {
  const total = Math.max(0, Number(run?.total) || 0);
  const answered = Math.min(total, Math.max(0, Number(run?.answered) || 0));
  const secs = Math.max(0, Math.round((now - (Number(run?.startedAt) || now)) / 1000));
  return `Testing ${total} cleanup model${total === 1 ? "" : "s"} · ${answered}/${total} answered · ${secs}s`;
}

/**
 * The whole panel: a bold title and one line per job, newest last, for the
 * host's single toast slot. Returns null when there is nothing to show.
 */
export function renderJobPanel(list, now = Date.now()) {
  const jobs = list ?? [];
  if (jobs.length === 0) return null;
  const labelWidth = Math.max(0, ...jobs.map((job) => String(job.label).length));
  const running = jobs.filter((job) => job.state === "running").length;
  const failed = jobs.some((job) => job.state === "failed");
  return {
    title: running > 0 ? `Voice · ${running} in progress` : "Voice · finished",
    message: jobs.map((job) => jobLine(job, now, labelWidth)).join("\n"),
    variant: failed ? "error" : running > 0 ? "info" : "success",
  };
}

/**
 * The "sox is missing" screen, shared by the wizard and the talk key. The
 * install command is far too long to survive a toast, so it lives in a dialog
 * row where it stays on screen until the user has run it and re-checked.
 * `checkSox` and `copy` are injectable so tests do not probe the real PATH
 * or clipboard.
 */
export function showSoxMissingDialog(
  api,
  toast,
  {
    title = "sox is not installed (recording needs it)",
    foundMessage = "sox found",
    onContinue,
    onFound,
    back,
    copy = (text) => copyToClipboard(api, text),
    checkSox = () => {
      invalidateBinaryCache();
      return hasBinary("sox");
    },
  } = {},
) {
  const command = soxInstallCommand();
  const menu = createMenu(api);
  const options = [
    {
      // The command doubles as its own copy button: selecting it puts it on
      // the clipboard for pasting into another terminal. It cannot be a
      // passive row - DialogSelect silently drops disabled ones.
      title: command,
      footer: "enter: copy",
      value: "command",
      onSelect() {
        return copy(command).then((how) => {
          toast(
            how === "tool"
              ? "Install command copied - paste it into another terminal"
              : how === "osc52"
                ? "Copied via terminal - if paste comes up empty, select the command text with your mouse"
                : "Could not copy - install xclip, or select the command text with your mouse",
            how ? "info" : "warning",
          );
        });
      },
    },
    {
      title: onContinue ? "Continue setup" : "Close",
      description: onContinue
        ? "run that in another terminal; recording works once it is there"
        : "run that in another terminal, then hold the talk key again",
      value: onContinue ? "continue" : "close",
      onSelect() {
        api.ui.dialog.clear();
        onContinue?.();
      },
    },
    {
      title: "Re-check",
      description: "already installed it",
      value: "recheck",
      onSelect() {
        if (checkSox()) {
          toast(foundMessage);
          api.ui.dialog.clear();
          onFound?.();
          return;
        }
        toast("sox is still not on PATH", "warning");
        showSoxMissingDialog(api, toast, {
          title,
          foundMessage,
          onContinue,
          onFound,
          back,
          checkSox,
        });
      },
    },
  ];
  addBackRow(options, back, "return to the previous screen");
  menu({
    title,
    options,
    back,
  });
}

export function createVoiceSetup(ctx) {
  // `state` is api.state: its config and provider list are resolved in the TUI
  // process, so they are readable on builds that serve none of the config
  // routes over HTTP.
  const { api, kv, client, state, logger, opts, toast, getTalkKey, setVoiceMode } = ctx;

  // Every screen here goes through the shared menu helper: it widens the
  // dialog past the 60-column default and clips each row to fit one line.
  const menu = createMenu(api);

  function dialog(title, options, back, onClose) {
    menu({ title, options, back, onClose });
  }

  // ---- Background jobs ----
  //
  // Installs and model downloads run detached from the wizard: the dialog
  // closes immediately so the user keeps working, progress lands in a toast,
  // and completion notifies. SEVERAL run at once - every model is its own
  // ~700 MB-1.1 GB download and queueing a second one while the first is in
  // flight is a normal thing to want - so jobs live in a registry keyed by
  // what they install rather than in a single slot.
  //
  // The host renders ONE toast at a time (its state is a single
  // `currentToast`, and every show() overwrites it), so separate stacked
  // notifications are not reachable from a plugin. One toast holding one
  // line per job is the closest honest thing, and reads the same way.

  const jobs = new Map(); // key -> { key, label, kind, model, proc, startedAt, ... }
  const JOB_TICK_MS = 900;
  // How long a finished job stays on the panel, so a completion that lands
  // while the user is typing is still readable afterwards.
  const JOB_LINGER_MS = 10000;
  let panelTimer = null;

  function activeJobs() {
    return [...jobs.values()].filter((job) => job.state === "running");
  }

  function panelJobs() {
    return [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  // Percentages come from the cache, not from the command's output: the
  // percentages `nemo-speech pull` appears to print are curl's own meter,
  // which curl draws only when stderr is a TTY. Piped - which is the only way
  // the plugin can read it - that meter never appears, which is why the old
  // "%"-scraping bar sat empty for the whole download. The size the CLI
  // announces up front plus the growing `.partial` on disk is a real
  // measurement of the same thing.
  function refreshJob(job) {
    if (job.state !== "running") return;
    job.tick = (job.tick ?? 0) + 1;
    if (job.kind !== "model") return;
    const state = nemoModelState(job.model);
    if (state.status === "ready") {
      job.percent = 100;
      return;
    }
    if (!job.totalBytes) return;
    // Held below 100 while running: the bytes land before the SHA-256 check
    // does, and a bar reading 100% next to a job that is still working looks
    // stuck rather than finishing.
    job.percent = Math.min(99, (state.bytes / job.totalBytes) * 100);
  }

  function paintPanel() {
    const list = panelJobs();
    for (const job of list) refreshJob(job);
    const panel = renderJobPanel(list, Date.now());
    if (!panel) return;
    const running = list.some((job) => job.state === "running");
    api.ui.toast({
      title: panel.title,
      message: panel.message,
      variant: panel.variant,
      // Outlives the tick so the panel never blinks out between refreshes;
      // the last paint after everything finishes stays put much longer.
      duration: running ? JOB_TICK_MS + 1600 : JOB_LINGER_MS,
    });
  }

  function schedulePanel() {
    if (panelTimer) return;
    panelTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, job] of jobs) {
        if (job.state !== "running" && now - job.finishedAt > JOB_LINGER_MS) jobs.delete(key);
      }
      if (jobs.size === 0) {
        clearInterval(panelTimer);
        panelTimer = null;
        return;
      }
      paintPanel();
    }, JOB_TICK_MS);
    // setInterval keeps the TUI's loop alive otherwise.
    panelTimer.unref?.();
  }

  function cancelJob(job) {
    // Only child processes can be stopped. In-process jobs (the cleanup
    // probe) have no `proc`: their requests are already in flight and there
    // is no honest way to call them back, so they are not offered as
    // cancellable rather than pretending.
    if (!job.proc) return false;
    // The command is `bash -c "... curl ..."`, so killing bash alone leaves
    // curl writing to the cache. The job runs in its own process group for
    // exactly this reason; the whole group goes.
    try {
      process.kill(-job.proc.pid, "SIGKILL");
    } catch {
      try {
        job.proc.kill("SIGKILL");
      } catch {}
    }
    return true;
  }

  /**
   * Register work the plugin does in-process (the cleanup probe) in the same
   * registry the downloads use, so it lands on the same progress panel. No
   * command, no `proc` - the caller drives it and calls finishTrackedJob.
   */
  function trackJob({ key, label, kind, detail = null }) {
    const existing = jobs.get(key);
    if (existing?.state === "running") return existing;
    const job = {
      key,
      label,
      kind,
      model: null,
      proc: null,
      startedAt: Date.now(),
      finishedAt: null,
      percent: null,
      totalBytes: 0,
      detail,
      tick: 0,
      state: "running",
      error: null,
    };
    jobs.set(key, job);
    schedulePanel();
    paintPanel();
    return job;
  }

  function finishTrackedJob(job, ok, reason) {
    if (!job || job.state !== "running") return;
    job.state = ok ? "done" : "failed";
    job.finishedAt = Date.now();
    job.error = ok ? null : reason;
    paintPanel();
  }

  function runJob({ key, label, command, kind = "install", model, onDone }) {
    const existing = jobs.get(key);
    if (existing?.state === "running") {
      toast(`${label} is already running`, "info");
      return existing;
    }
    const startedAt = Date.now();
    logger?.log("STT", `Setup job started: ${label} (${command})`, "debug");
    const proc = spawn("bash", ["-c", command], {
      env: {
        ...process.env,
        PATH: `${path.join(os.homedir(), ".local", "bin")}:${process.env.PATH}`,
      },
      stdio: ["ignore", "ignore", "pipe"],
      // Own process group, so cancelling takes the download with it.
      detached: true,
    });
    const job = {
      key,
      label,
      kind,
      model,
      proc,
      startedAt,
      finishedAt: null,
      percent: null,
      totalBytes: 0,
      tick: 0,
      state: "running",
      error: null,
    };
    jobs.set(key, job);

    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = `${stderr}${text}`.slice(-2000);
      if (!job.totalBytes) job.totalBytes = parseNemoDownloadTotal(text);
    });

    const finish = (ok, reason) => {
      if (job.state !== "running") return;
      job.state = ok ? "done" : "failed";
      job.finishedAt = Date.now();
      job.percent = ok ? 100 : job.percent;
      job.error = ok ? null : reason;
      invalidateBinaryCache();
      logger?.log("STT", `Setup job ${job.state}: ${label}${ok ? "" : ` (${reason})`}`, "debug");
      paintPanel();
      onDone?.(ok);
    };
    proc.on("error", (err) => finish(false, err.message));
    proc.on("exit", (code) => {
      if (code === 0) {
        finish(true);
        return;
      }
      const last = stderr.trim().split("\n").pop();
      finish(false, last?.slice(0, 60) || `exit ${code}`);
    });

    schedulePanel();
    paintPanel();
    return job;
  }

  /**
   * Download one transcription model in the background. Idempotent: a model
   * already downloading keeps its existing job, and `pull` on a cached model
   * returns at once.
   */
  function downloadModel(model, { onDone } = {}) {
    const repo = nemoModelRepo(model);
    if (!repo) {
      toast(`Unknown transcription model: ${model}`, "warning");
      return null;
    }
    if (!hasBinary("nemo-speech")) {
      toast("nemo-speech is not installed yet - run /voice", "warning");
      return null;
    }
    return runJob({
      key: `model:${model}`,
      // The picker's own name for it, so the panel line and the row match.
      label: NEMO_MODELS[model]?.short ?? repo,
      kind: "model",
      model,
      command: `nemo-speech pull ${repo}`,
      onDone,
    });
  }

  function jobsDialog({ back } = {}) {
    const list = panelJobs();
    const options = list.map((job) => {
      // In-process work (the cleanup probe) cannot be called back once its
      // requests are out, so its row says what it is doing instead of
      // offering a cancel that would not stop anything.
      const cancellable = job.state === "running" && Boolean(job.proc);
      return {
        title: job.label,
        description:
          job.state === "running"
            ? (job.detail ??
              (job.percent == null
                ? "working"
                : `${progressBar(job.percent)} ${Math.round(job.percent)}%`))
            : job.state === "done"
              ? "done"
              : `failed · ${job.error ?? "see README"}`,
        footer: cancellable ? "enter: cancel" : job.state === "running" ? "in progress" : undefined,
        value: job.key,
        onSelect() {
          if (!cancellable) return;
          cancelJob(job);
          toast(`${job.label} · cancelled`, "warning");
          // Re-render rather than close: cancelling one of several downloads
          // is not a reason to lose sight of the others.
          jobsDialog({ back });
        },
      };
    });
    if (back) {
      addBackRow(options, back, "everything here continues in the background");
    } else {
      options.push({
        title: "Keep them running",
        description: "closes this screen, everything continues in the background",
        value: "back",
        onSelect() {
          api.ui.dialog.clear();
        },
      });
    }
    const running = activeJobs().length;
    dialog(running > 0 ? `Voice · ${running} in progress` : "Voice · recent jobs", options, back);
  }

  // ---- Wizard steps ----

  // Step 0 (only when sox is missing): recording needs it, and unlike
  // nemo-speech it comes from the system package manager and needs root, so
  // the wizard can only name the command. Setup continues either way - the
  // rest of it still applies - but saying nothing here is what left a fresh
  // user with "Setup complete" and a bare spawn error at the first key press.
  function stepSox({ next, back }) {
    showSoxMissingDialog(api, toast, {
      title: "Setup · sox is not installed (recording needs it)",
      onContinue: next,
      onFound: next,
      back,
    });
  }

  // Step 0 (only when the engine is missing): install nemo-speech.
  function stepInstall({ back } = {}) {
    const options = [
      {
        title: "Install it for me",
        description: "downloads in the background, keep working",
        value: "install",
        onSelect() {
          api.ui.dialog.clear();
          runJob({
            key: "install:nemo-speech",
            label: "nemo-speech",
            command: NEMO_INSTALL_CMD,
            onDone(ok) {
              if (!ok || !hasBinary("nemo-speech")) return;
              const model = normalizeNemoModel(kv.get("stt.nemo.model"));
              kv.set("stt.nemo.model", model);
              // The engine alone still cannot transcribe; chaining the model
              // pull is what makes "install it for me" mean ready to dictate.
              downloadModel(model);
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
    ];
    addBackRow(options, back, "return to the previous screen");
    dialog("Setup · nemo-speech is not installed", options, back);
  }

  // Step 0b (only when no model is downloaded yet): transcribing needs the
  // ~700 MB GGUF, and the first dictation is the wrong moment to discover
  // that - the talk key sits "busy" for the whole download with nothing on
  // screen saying why. Pull it here instead, with the same progress machinery
  // as the installer, so "setup complete" actually means ready to dictate.
  // Also opened by the talk key, which refuses to record without a model
  // rather than downloading one inside the dictation - hence the explicit
  // `model` and `title`, so the same screen can say why it appeared.
  function stepPrewarm({ model: requested, next, title, back } = {}) {
    // Same reading of the stored setting the gate uses. Two spellings of it
    // is what made this screen offer one model while the gate demanded
    // another, so setup asked for two ~700 MB downloads before moving on.
    const model = requested ?? normalizeNemoModel(kv.get("stt.nemo.model"));
    const name = NEMO_MODELS[model]?.short ?? model;
    const partial = nemoModelState(model).status === "partial";
    const options = [
      {
        title: partial ? "Resume the download" : "Download it for me",
        description: "~700 MB in the background, keep working",
        value: "pull",
        onSelect() {
          api.ui.dialog.clear();
          downloadModel(model);
          // The download does not block the rest of setup: cleanup model and
          // input mode are still worth picking while it comes down.
          next?.();
        },
      },
      {
        title: "Not now",
        // Named plainly: this used to say the first dictation would download
        // it, which was both a surprise and a trap - the download ran inside
        // the transcription call with the talk key wedged for its duration.
        // Nothing downloads on its own now, so the honest cost of "not now"
        // is that dictation does not work until you come back here.
        description: "dictation stays unavailable until you download it",
        value: "cancel",
        onSelect() {
          api.ui.dialog.clear();
          // Setup still finishes: the cleanup model and input mode are worth
          // picking either way, and dropping out here left the wizard
          // half-done with nothing said about it.
          next?.();
        },
      },
    ];
    addBackRow(options, back, "return to the previous screen");
    dialog(title ?? `Setup · ${name} is not downloaded yet`, options, back);
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
    const stillCurrent = menu.guard();
    listCleanupModels(client, logger, { state })
      .then((models) => {
        if (!stillCurrent()) return;
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
        addBackRow(options, back, "keep the current cleanup model");
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
          back,
        });
      })
      .catch((err) => {
        if (!stillCurrent()) return;
        logger?.log("STT", `Model list failed: ${err.message}`, "warn");
        toast("Could not load models", "error");
      });
  }

  // ---- Cleanup model auto-pick ----
  //
  // Availability lists guess; the probe knows. Fires one tiny cleanup-shaped
  // request at each small model (a few at a time), then ranks by homophone
  // fixes then latency, best match on top. Models that failed are listed
  // below the working ones with their reason rather than vanishing: a model
  // missing from the list looks like a bug, and the reason is what tells the
  // user whether to reauth, wait out a rate limit, or pick something else.
  // Recent results are reused so re-opening the list is instant - the title
  // says how old they are, and "Test again" re-probes everything on demand.
  const PROBE_CACHE_MS = 5 * 60_000;
  const PROBE_LIMIT = 8;
  const probeCache = new Map(); // model id -> { result, at }

  // ONE probe run at a time. A round is a real request per model and takes
  // tens of seconds, during which the menu sits there looking idle - so
  // pressing "Test and auto-pick" again is the natural thing to do, and every
  // press used to fire a whole second round at the same models (and land a
  // second results screen on top of the first). This holds the run in flight
  // so a second press shows its progress instead of doubling the load.
  //
  // `render` is cleared when the user navigates away from the waiting screen:
  // the round still finishes and still fills the cache, but it must not open
  // a results menu over whatever the user moved on to.
  let probeRun = null; // { total, answered, startedAt, job, render }

  function probeRunningDialog({ next, back } = {}) {
    const run = probeRun;
    if (!run) {
      // Finished between the press and this render.
      toast("Testing finished", "success");
      return;
    }
    const leave = () => {
      run.render = false;
    };
    let keepResults = false;
    const options = [
      {
        title: "Keep waiting",
        description: "results open here as soon as every model answers",
        value: "wait",
        onSelect() {
          keepResults = true;
          api.ui.dialog.clear();
        },
      },
      {
        // The dialog is a snapshot - DialogSelect does not re-render itself -
        // so the count needs a way to be asked for again. The toast panel
        // ticks on its own for anyone who closed this screen.
        title: "Check progress",
        description: "refresh the count on this screen",
        value: "refresh",
        onSelect() {
          keepResults = true;
          probeRunningDialog({ next, back });
        },
      },
      {
        title: "Skip cleanup",
        description: "dictate without the cleanup pass",
        value: "skip",
        onSelect() {
          leave();
          kv.set("cleanup.mode", "skip");
          toast("Text cleanup off · raw dictation");
          if (next) {
            next();
            return;
          }
          api.ui.dialog.clear();
        },
      },
    ];
    const goBack = back
      ? () => {
          leave();
          back();
        }
      : undefined;
    addBackRow(options, goBack, "testing continues in the background");
    dialog(probeTestingTitle(run), options, goBack, () => {
      if (!keepResults) leave();
    });
  }

  async function runCleanupAutoPick({ next, back, fresh = false } = {}) {
    const stillCurrent = menu.guard();
    // Before any await, so two presses in the same tick cannot both get past.
    if (probeRun) {
      probeRun.render = true;
      probeRunningDialog({ next, back });
      return;
    }
    // "Test again" also re-detects the transport, so fixing auth or starting
    // a server takes effect without restarting the TUI.
    if (fresh) await resolveTransport(client, logger, { refresh: true });
    if (!stillCurrent()) return;
    const models = await listCleanupModels(client, logger, { state });
    if (!stillCurrent()) return;
    const small = models.filter((m) => m.small).slice(0, PROBE_LIMIT);
    if (small.length === 0) {
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
    const probed = [];
    // Nothing to probe (every result still fresh) means no waiting screen and
    // no run to guard: the cached results open immediately.
    let render = true;
    if (stale.length > 0) {
      const run = {
        total: stale.length,
        answered: 0,
        startedAt: Date.now(),
        render: true,
        // Same panel the downloads use, so a user who navigates away still
        // sees the round ticking instead of losing track of it entirely.
        job: trackJob({
          key: "probe:cleanup",
          label: "Testing cleanup models",
          kind: "probe",
          detail: `0/${stale.length} answered`,
        }),
      };
      probeRun = run;
      probeRunningDialog({ next, back });
      try {
        // probeCleanupModels picks the transport this host actually serves
        // (/v1 or session chat) and caps concurrency, so a burst of probes
        // does not itself trip the rate limit being measured.
        probed.push(
          ...(await probeCleanupModels(client, stale, logger, {
            limit: PROBE_LIMIT,
            onResult() {
              run.answered += 1;
              run.job.detail = `${run.answered}/${run.total} answered`;
              paintPanel();
            },
          })),
        );
      } finally {
        // Released before the results render, so "Test again" on the results
        // screen is not refused by the guard for a run that already ended.
        probeRun = null;
        finishTrackedJob(run.job, true);
      }
      // The user left the waiting screen: the round still filled the cache,
      // but its results must not open a menu over wherever they went.
      render = run.render;
      for (const result of probed) {
        // Cache only working probes. A failed one (server hiccup, missing
        // auth) must be retried on the next open, not served from cache as
        // an authoritative "model does not respond" for five minutes.
        if (result.ok) probeCache.set(result.id, { result, at: now });
      }
    }
    // Failures are not cached, so a model's reason comes from this run only.
    const errors = new Map(probed.filter((r) => !r.ok).map((r) => [r.id, r.error]));
    const results = rankProbeResults(
      small.map((m) => ({
        id: m.id,
        name: m.name,
        error: errors.get(m.id),
        ...probeCache.get(m.id)?.result,
      })),
    );
    const working = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
      logger?.log(
        "STT",
        `Auto-pick probe failures: ${failed.map((r) => `${r.id}: ${r.error ?? "unknown"}`).join("; ")}`,
        working.length === 0 ? "warn" : "debug",
      );
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
    // Failed models stay on screen, showing why they failed: HTTP 429 is the
    // host's rate limit, 401/403 means reauth, 404 means the catalog listed a
    // model this server does not serve. Dropping them - which is what
    // disabled rows do, DialogSelect filters those out - would read as the
    // model list itself being broken. Selecting one re-states the failure.
    for (const r of failed) {
      options.push({
        title: shortLabel(r.id),
        description: r.error ?? "no response",
        value: `failed:${r.id}`,
        onSelect() {
          toast(`${r.id}: ${r.error ?? "no response"}`, "warning");
        },
      });
    }
    options.push({
      title: "Test again",
      description: "re-check the connection and probe every model again",
      value: "retest",
      onSelect() {
        runCleanupAutoPick({ next, back, fresh: true }).catch((err) => {
          logger?.log("STT", `Auto-pick failed: ${err.message}`, "warn");
          toast("Auto-pick failed", "error");
        });
      },
    });
    // A screen with nothing selectable is a dead end, so the ways out of a
    // total failure are on it: pick by hand, or dictate without cleanup.
    if (working.length === 0) {
      options.push({
        title: "Browse all models",
        description: "pick one by hand, including models not tagged small",
        value: "browse",
        onSelect() {
          showCleanupModelDialog({ next, back, all: true });
        },
      });
      options.push({
        title: "Skip cleanup",
        description: "dictate without the cleanup pass",
        value: "skip",
        onSelect() {
          kv.set("cleanup.mode", "skip");
          toast("Text cleanup off · raw dictation");
          if (next) {
            next();
            return;
          }
          api.ui.dialog.clear();
        },
      });
    }
    addBackRow(options, back, "keep the current cleanup model");
    // The user walked away from the waiting screen while the round ran. The
    // results are cached and one press reopens them instantly; stealing the
    // screen back from whatever they are doing now would not be a kindness.
    if (!render) {
      toast(`Testing done · ${working.length}/${small.length} responded`, "success", 6000);
      return;
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
      back,
    });
  }

  // Step 1: which LLM cleans up the raw transcript. Also reachable on its own
  // from the /voice settings hub, hence the configurable title and follow-up.
  function stepCleanup({
    title = "Setup 1/2 · clean up dictation with",
    next = stepMode,
    back,
  } = {}) {
    if (opts?.endpoint) {
      // tui.json already pins an endpoint - nothing to ask, skip ahead.
      next();
      return;
    }
    const stillCurrent = menu.guard();
    resolveOpencodeCleanup(client, logger, { state }).then((resolved) => {
      if (!stillCurrent()) return;
      const options = resolved.candidates.slice(0, 3).map((candidate, i) => ({
        title: shortLabel(candidate),
        description: i === 0 ? "recommended · your opencode small model" : undefined,
        value: `model-${i}`,
        onSelect() {
          kv.set("cleanup.mode", "opencode");
          kv.set("cleanup.model", candidate);
          next();
        },
      }));
      // Both paths run cleanup through the host server, so they need one of
      // its transports to exist. When neither does, the only honest offer
      // left is dictating without cleanup.
      if (resolved.available) {
        options.push({
          title: "Test and auto-pick",
          description: "probes your small models live, ranks the best",
          value: "autopick",
          onSelect() {
            // `back` rides along, so the screens under this one lead all the
            // way out to wherever cleanup was opened from rather than
            // dead-ending on this step.
            runCleanupAutoPick({ next, back: () => stepCleanup({ title, next, back }) }).catch(
              (err) => {
                logger?.log("STT", `Auto-pick failed: ${err.message}`, "warn");
                toast("Auto-pick failed", "error");
              },
            );
          },
        });
        options.push({
          title: "Browse all models",
          description: "like /models, used only for cleanup",
          value: "browse",
          onSelect() {
            showCleanupModelDialog({ next, back: () => stepCleanup({ title, next, back }) });
          },
        });
      }
      options.push({
        title: "Skip cleanup",
        description: resolved.available ? "keep raw dictation" : "no opencode server found",
        value: "skip",
        onSelect() {
          kv.set("cleanup.mode", "skip");
          next();
        },
      });
      addBackRow(options, back, "keep the current cleanup model");
      dialog(title, options, back);
    });
  }

  // Step 2: how the talk key behaves.
  function stepMode({ back } = {}) {
    const options = [
      {
        // Whether the text is then submitted is the separate auto-submit
        // setting, so these rows stop at "transcribe" and do not promise a send.
        title: `Push to talk · hold ${getTalkKey()}`,
        description: "recommended · release to stop and transcribe",
        value: "hold",
        onSelect() {
          finish("hold");
        },
      },
      {
        title: `Tap to toggle · tap ${getTalkKey()}`,
        description: "tap again to stop and transcribe",
        value: "tap",
        onSelect() {
          finish("tap");
        },
      },
    ];
    addBackRow(options, back, "return to the previous screen");
    dialog("Setup 2/2 · input mode", options, back);
  }

  function finish(mode) {
    setVoiceMode(mode, { silent: true });
    kv.set("voice.setupDone", true);
    api.ui.dialog.clear();
    toast(
      mode === "tap"
        ? `Setup complete · tap ${getTalkKey()}, talk, tap again`
        : `Setup complete · hold ${getTalkKey()} and talk`,
      "success",
    );
  }

  // ---- Entry point ----

  function run({ back } = {}) {
    if (activeJobs().length > 0) {
      jobsDialog({ back });
      return;
    }
    // sox first: it is the one prerequisite the user has to install by hand,
    // so it is worth naming before they spend the rest of the wizard.
    if (!hasBinary("sox")) {
      const showSox = () => stepSox({ next: () => runEngineSteps({ back: showSox }), back });
      showSox();
      return;
    }
    runEngineSteps({ back });
  }

  function runEngineSteps({ back } = {}) {
    if (!hasBinary("nemo-speech")) {
      stepInstall({ back });
      return;
    }
    // Resolved once and written back, so the gate below and the screen it
    // opens are looking at the same model. Reading the setting twice with two
    // different fallbacks is what asked for a second download.
    const model = normalizeNemoModel(kv.get("stt.nemo.model"));
    kv.set("stt.nemo.model", model);
    // Per-model: the picked model is the one the next dictation needs, and
    // "some other model is cached" is exactly the check that let a model
    // switch reach the talk key with nothing downloaded.
    if (!hasVerifiedNemoModel(model)) {
      const showPrewarm = () => stepPrewarm({ model, next: () => setupCleanup(showPrewarm), back });
      showPrewarm();
      return;
    }
    setupCleanup(back);
  }

  function setupCleanup(rootBack) {
    // A pinned endpoint skips the cleanup picker, so the mode screen's parent
    // is the settings hub rather than a screen that would immediately skip.
    if (opts?.endpoint) {
      stepMode({ back: rootBack });
      return;
    }
    const showCleanup = () =>
      stepCleanup({
        back: rootBack,
        next: () => stepMode({ back: showCleanup }),
      });
    showCleanup();
  }

  return {
    run,
    // Re-pick the cleanup model on its own, from the /voice settings hub.
    chooseCleanup: (o) => stepCleanup(o),
    // Start (or join) a model download from the /stt-model picker.
    downloadModel,
    // The talk key opens this instead of recording when the model is absent.
    showModelMissing: (o) => stepPrewarm(o),
    // The /voice hub lists running downloads as a row of its own.
    jobsRunning: () => activeJobs().length,
    showJobs: jobsDialog,
    // Which models this session is downloading right now - the picker marks
    // those rows, and the cache alone cannot tell in-flight from abandoned.
    downloadingModels: () =>
      new Set(
        activeJobs()
          .filter((job) => job.kind === "model")
          .map((job) => job.model),
      ),
  };
}
