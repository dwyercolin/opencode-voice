import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAge,
  formatBytes,
  jobLine,
  probeTestingTitle,
  progressBar,
  renderJobPanel,
  showSoxMissingDialog,
  spinnerBar,
} from "../lib/setup.js";
import { soxInstallCommand } from "../lib/engines.js";

test("renders a compact progress bar", () => {
  assert.equal(progressBar(0), "░░░░░░░░░░");
  assert.equal(progressBar(47), "█████░░░░░");
  assert.equal(progressBar(50), "█████░░░░░");
  assert.equal(progressBar(100), "██████████");
  assert.equal(progressBar(120), "██████████");
  assert.equal(progressBar(-5), "░░░░░░░░░░");
  assert.equal(progressBar(null), "░░░░░░░░░░");
  assert.equal(progressBar(100, 4), "████");
});

test("renders an indeterminate spinner bar", () => {
  assert.equal(spinnerBar(0), "█░░░░░░░░░");
  assert.equal(spinnerBar(3), "░░░█░░░░░░");
  assert.equal(spinnerBar(9), "░░░░░░░░░█");
  assert.equal(spinnerBar(10), "█░░░░░░░░░");
  assert.equal(spinnerBar(-1), "█░░░░░░░░░");
});

test("formatAge says whether probe results are fresh or reused", () => {
  // A run that just finished must not look like cached numbers.
  assert.equal(formatAge(0), "just tested");
  assert.equal(formatAge(4000), "just tested");
  assert.equal(formatAge(40_000), "tested 40s ago");
  assert.equal(formatAge(120_000), "tested 2m ago");
  // Results expire at 5 minutes, so anything older is a re-probe.
  assert.equal(formatAge(4 * 60_000), "tested 4m ago");
  assert.equal(formatAge(-5), "just tested");
  assert.equal(formatAge(null), "just tested");
});

test("formatBytes states download sizes the way the CLI announces them", () => {
  assert.equal(formatBytes(1123.5 * 1024 ** 2), "1.1 GB");
  assert.equal(formatBytes(713975456), "681 MB");
  assert.equal(formatBytes(2048), "2 KB");
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(-5), "0 B");
  assert.equal(formatBytes(null), "0 B");
});

test("jobLine shows a real bar for downloads and a spinner for sizeless installs", () => {
  const startedAt = 1000;
  const now = 61_000;
  // A model download knows its total, so it gets a measured percentage.
  assert.equal(
    jobLine(
      { label: "Parakeet CTC", state: "running", startedAt, percent: 85, totalBytes: 1024 ** 3 },
      now,
    ),
    "Parakeet CTC  █████████░ 85% · 1.0 GB",
  );
  // The installer reports no size at all; a moving cell says "alive" without
  // inventing a percentage the plugin cannot measure.
  assert.equal(
    jobLine({ label: "nemo-speech", state: "running", startedAt, percent: null, tick: 3 }, now),
    "nemo-speech  ░░░█░░░░░░ 60s",
  );
  // Finished jobs time themselves from when they finished, not from "now".
  assert.equal(
    jobLine({ label: "Parakeet TDT", state: "done", startedAt, finishedAt: 41_000 }, now),
    "Parakeet TDT  done · 40s",
  );
  assert.equal(
    jobLine(
      { label: "nemo-speech", state: "failed", startedAt, finishedAt: now, error: "exit 1" },
      now,
    ),
    "nemo-speech  failed · exit 1",
  );
});

test("jobLine counts in-process work in its own units", () => {
  const startedAt = 1000;
  const now = 61_000;
  // The cleanup probe measures nothing in bytes and has no percentage to
  // report - the honest number is how many models have answered so far, and
  // that is the whole point of the line: the round used to look like nothing
  // was happening at all.
  assert.equal(
    jobLine(
      {
        label: "Testing cleanup models",
        state: "running",
        startedAt,
        percent: null,
        tick: 3,
        detail: "3/8 answered",
      },
      now,
    ),
    "Testing cleanup models  ░░░█░░░░░░ 60s · 3/8 answered",
  );
  // The count survives into the finished line, so a panel seen afterwards
  // still says what the round actually did.
  assert.equal(
    jobLine(
      {
        label: "Testing cleanup models",
        state: "done",
        startedAt,
        finishedAt: 41_000,
        detail: "8/8 answered",
      },
      now,
    ),
    "Testing cleanup models  done · 8/8 answered · 40s",
  );
  // `detail` wins over a byte total; only one of them is ever set.
  assert.equal(
    jobLine(
      {
        label: "x",
        state: "running",
        startedAt,
        percent: 50,
        totalBytes: 1024 ** 3,
        detail: "1/2",
      },
      now,
    ),
    "x  █████░░░░░ 50% · 1/2",
  );
});

test("probeTestingTitle counts answers rather than saying 'working'", () => {
  const startedAt = 1000;
  // A second press of "Test and auto-pick" lands on this title, so it has to
  // answer the only question the user has: how many are left.
  assert.equal(
    probeTestingTitle({ total: 8, answered: 3, startedAt }, 61_000),
    "Testing 8 cleanup models · 3/8 answered · 60s",
  );
  assert.equal(
    probeTestingTitle({ total: 1, answered: 0, startedAt }, 3000),
    "Testing 1 cleanup model · 0/1 answered · 2s",
  );
  // A stray extra answer must not read as "9/8".
  assert.equal(
    probeTestingTitle({ total: 8, answered: 12, startedAt }, 1000),
    "Testing 8 cleanup models · 8/8 answered · 0s",
  );
  // Never renders NaN when called before the run is fully populated.
  assert.equal(probeTestingTitle(null, 1000), "Testing 0 cleanup models · 0/0 answered · 0s");
});

test("renderJobPanel stacks one line per job in the host's single toast slot", () => {
  const now = 61_000;
  // The host keeps ONE toast (its state is a single currentToast), so several
  // concurrent downloads have to read as several lines of one panel.
  const panel = renderJobPanel(
    [
      { label: "Parakeet CTC", state: "running", startedAt: 1000, percent: 50, totalBytes: 0 },
      { label: "Nemotron 3.5", state: "running", startedAt: 2000, percent: null, tick: 0 },
    ],
    now,
  );
  assert.equal(panel.title, "Voice · 2 in progress");
  assert.equal(panel.variant, "info");
  const lines = panel.message.split("\n");
  assert.equal(lines.length, 2);
  // Labels are padded to a common width so the bars line up as a column.
  assert.ok(
    lines.every((line) => line.startsWith("Parakeet CTC") || line.startsWith("Nemotron 3.5")),
  );
  assert.ok(lines[0].includes("50%"));

  // Once everything lands the panel says so rather than claiming progress.
  const done = renderJobPanel(
    [{ label: "Parakeet TDT", state: "done", startedAt: 1000, finishedAt: 5000 }],
    now,
  );
  assert.equal(done.title, "Voice · finished");
  assert.equal(done.variant, "success");

  // One failure colours the whole panel: it is the only place the reason shows.
  const failed = renderJobPanel(
    [{ label: "nemo-speech", state: "failed", startedAt: 1000, finishedAt: 5000, error: "exit 1" }],
    now,
  );
  assert.equal(failed.variant, "error");
  assert.ok(failed.message.includes("exit 1"));

  // Nothing running and nothing recent means nothing to paint.
  assert.equal(renderJobPanel([]), null);
  assert.equal(renderJobPanel(null), null);
});

// The dialog helper renders through the same menu path the TUI uses; this
// harness captures what the host would have displayed.
function mockTui() {
  const opens = [];
  const cleared = [];
  const toasts = [];
  const api = {
    renderer: { width: 120 },
    ui: {
      dialog: {
        replace: (render) => opens.push(render()),
        clear: () => cleared.push(true),
        setSize: () => {},
      },
      DialogSelect: (props) => props,
    },
  };
  return {
    api,
    toasts,
    cleared,
    opens,
    row: (value) => opens.at(-1).options.find((o) => o.value === value),
    select: (value) =>
      opens
        .at(-1)
        .options.find((o) => o.value === value)
        ?.onSelect(),
  };
}

test("missing-sox dialog keeps the install command on screen", () => {
  const t = mockTui();
  showSoxMissingDialog(t.api, (m) => t.toasts.push(m), { checkSox: () => false });
  const command = t.row("command");
  // DialogSelect silently drops rows with disabled: true, so the command must
  // stay a selectable row - it is its own copy button.
  assert.equal(command.disabled, undefined);
  assert.ok(String(command.title).includes("sudo apt install sox"));
  assert.equal(t.row("close").title.trim(), "Close");
  assert.equal(t.row("recheck").title.trim(), "Re-check");
  assert.equal(t.row("continue"), undefined);
});

test("selecting the command row copies it and says so", async () => {
  const t = mockTui();
  let copied = null;
  showSoxMissingDialog(t.api, (m) => t.toasts.push(m), {
    checkSox: () => false,
    copy: (text) => {
      copied = text;
      return Promise.resolve("tool");
    },
  });
  await t.row("command").onSelect();
  assert.equal(copied, soxInstallCommand());
  assert.deepEqual(t.toasts, ["Install command copied - paste it into another terminal"]);
});

test("a failed copy leaves the command on screen and says so", async () => {
  const t = mockTui();
  showSoxMissingDialog(t.api, (m) => t.toasts.push(m), {
    checkSox: () => false,
    copy: () => Promise.resolve(false),
  });
  await t.row("command").onSelect();
  assert.match(t.toasts[0], /[Cc]ould not copy/);
});

test("re-checking after installing sox closes the dialog and reports ready", () => {
  const t = mockTui();
  let found = false;
  showSoxMissingDialog(t.api, (m) => t.toasts.push(m), {
    foundMessage: "sox found - hold ctrl+r to record",
    onFound: () => {
      found = true;
    },
    checkSox: () => true,
  });
  t.select("recheck");
  assert.equal(found, true);
  assert.equal(t.cleared.length, 1);
  assert.deepEqual(t.toasts, ["sox found - hold ctrl+r to record"]);
});

test("re-check without sox installed re-opens the dialog instead of losing it", () => {
  const t = mockTui();
  showSoxMissingDialog(t.api, (m) => t.toasts.push(m), { checkSox: () => false });
  t.select("recheck");
  assert.equal(t.opens.length, 2);
  assert.equal(t.cleared.length, 0);
  assert.ok(t.toasts.some((m) => m.includes("still not on PATH")));
});

test("wizard variant swaps Close for Continue setup and installs the command", () => {
  const t = mockTui();
  let continued = false;
  showSoxMissingDialog(t.api, () => {}, {
    title: "Setup · sox is not installed (recording needs it)",
    onContinue: () => {
      continued = true;
    },
  });
  assert.ok(String(t.row("command").title).includes(soxInstallCommand()));
  assert.equal(t.row("continue").title.trim(), "Continue setup");
  assert.equal(t.row("close"), undefined);
  t.select("continue");
  assert.equal(continued, true);
  assert.equal(t.cleared.length, 1);
});

test("missing-sox dialog returns to its parent when one is provided", () => {
  const t = mockTui();
  let backCalls = 0;
  showSoxMissingDialog(t.api, () => {}, {
    back: () => backCalls++,
    checkSox: () => false,
  });
  assert.equal(t.row("back").title.trim(), "← Back");
  assert.equal(t.row("back").footer, "alt+left");
  t.select("back");
  assert.equal(backCalls, 1);
});
