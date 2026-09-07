import assert from "node:assert/strict";
import test from "node:test";

import { formatAge, progressBar, showSoxMissingDialog, spinnerBar } from "../lib/setup.js";
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
