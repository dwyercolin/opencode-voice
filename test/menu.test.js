import assert from "node:assert/strict";
import test from "node:test";

import {
  BACK_KEY,
  DIALOG_WIDTHS,
  addBackRow,
  createMenu,
  displayWidth,
  fitRows,
  rowWidth,
  shortLabel,
} from "../lib/menu.js";

test("rowWidth budgets each dialog size minus row chrome", () => {
  assert.equal(rowWidth("medium"), DIALOG_WIDTHS.medium - 8);
  assert.equal(rowWidth("large"), DIALOG_WIDTHS.large - 8);
  assert.equal(rowWidth("xlarge"), DIALOG_WIDTHS.xlarge - 8);
  // Unknown sizes fall back to the size dialogs actually open at.
  assert.equal(rowWidth(), rowWidth("medium"));
  assert.equal(rowWidth("enormous"), rowWidth("medium"));
});

test("rowWidth clamps to the terminal, which the host also does", () => {
  // Panel is min(size, terminal - 2), so a narrow terminal wins.
  assert.equal(rowWidth("xlarge", 60), 60 - 2 - 8);
  // A wide terminal does not widen the panel past its fixed size.
  assert.equal(rowWidth("large", 300), DIALOG_WIDTHS.large - 8);
  // Never returns something unusably small.
  assert.equal(rowWidth("large", 10), 24);
});

test("shortLabel keeps the tail of long ids", () => {
  assert.equal(shortLabel("anthropic/claude-sonnet-4-5"), "anthropic/claude-sonnet-4-5");
  assert.equal(shortLabel("abcdefghij", 10), "abcdefghij");
  assert.equal(shortLabel("abcdefghijkl", 10), "…defghijkl");
  assert.equal(shortLabel("abcdefghijkl", 10).length, 10);
  assert.equal(shortLabel(""), "");
  assert.equal(shortLabel(null), "");
  assert.equal(shortLabel(undefined), "");
});

test("fitRows pads titles to a common width", () => {
  const rows = fitRows(
    [
      { title: "Hold ctrl+r", description: "recommended", value: "hold" },
      { title: "Tap", value: "tap" },
    ],
    80,
  );
  assert.equal(rows[0].title, "Hold ctrl+r");
  assert.equal(rows[1].title, "Tap        ");
  assert.equal(rows[0].title.length, rows[1].title.length);
  // Everything else on the option survives the copy.
  assert.equal(rows[0].description, "recommended");
  assert.equal(rows[1].value, "tap");
});

test("fitRows aligns localized descriptions by terminal width", () => {
  const rows = fitRows(
    [
      { title: "العربية", description: "Arabic" },
      { title: "हिन्दी", description: "Hindi" },
      { title: "ไทย", description: "Thai" },
      { title: "中文", description: "Chinese" },
    ],
    40,
  );
  assert.deepEqual(
    rows.map((row) => displayWidth(row.title)),
    [7, 7, 7, 7],
  );
});

test("fitRows sizes the column from described rows, not the longest title", () => {
  // The mic picker: one short row with a value beside it, and raw device ids
  // that carry nothing. Padding out to the device id starved the description.
  const device = "Yeti Stereo Microphone (alsa_input.usb-Blue_Microphones_Yeti-00.analog-stereo)";
  const [fallback, mic] = fitRows(
    [
      { title: "System default", description: "follow the OS input setting", value: "" },
      { title: device, value: "yeti" },
    ],
    rowWidth("xlarge"),
  );
  assert.equal(fallback.description, "follow the OS input setting");
  assert.equal(fallback.title, "System default");
  // Nothing follows the long title, so it is neither padded nor cut.
  assert.equal(mic.title, device);
});

test("fitRows keeps full descriptions when the row has space", () => {
  // The /voice hub's widest title next to its longest value. At the old
  // 60-column default this description lost its last nine characters.
  const hub = [
    { title: "Transcription model", value: "model" },
    { title: "Auto-submit", description: "off · text lands in the prompt for review" },
  ];
  const [, autosubmit] = fitRows(hub, rowWidth("large"));
  assert.equal(autosubmit.description, "off · text lands in the prompt for review");

  const [, clipped] = fitRows(hub, rowWidth("medium"));
  assert.ok(clipped.description.length < autosubmit.description.length);
  assert.ok(clipped.description.endsWith("…"));
});

test("fitRows clips descriptions that would overflow, marking the cut", () => {
  const [row] = fitRows([{ title: "Auto-submit", description: "x".repeat(40) }], 30);
  // 30 columns - 11 title - 1 gap = 18 for the description.
  assert.equal(row.description.length, 18);
  assert.ok(row.description.endsWith("…"));
  assert.equal(`${row.title} ${row.description}`.length, 30);
});

test("fitRows charges the right-aligned footer against the description", () => {
  const width = 40;
  const [plain] = fitRows([{ title: "id", description: "y".repeat(50) }], width);
  const [withFooter] = fitRows(
    [{ title: "id", description: "y".repeat(50), footer: "3/3 fixes" }],
    width,
  );
  assert.ok(withFooter.description.length < plain.description.length);
  assert.equal(plain.description.length - withFooter.description.length, "3/3 fixes".length + 2);
});

test("fitRows drops a description rather than show a useless stub", () => {
  const [row] = fitRows([{ title: "A very long settings label", description: "on" }], 30);
  assert.equal(row.description, undefined);
});

test("fitRows clips titles that overflow the row, marking the cut", () => {
  const rows = fitRows(
    [
      { title: `opencode/${"z".repeat(60)}`, value: "a" },
      { title: "Back", value: "back" },
    ],
    30,
  );
  assert.equal(rows[0].title.length, 30);
  assert.ok(rows[0].title.endsWith("…"));
  // Neither row carries a description, so there is no column to pad to.
  assert.equal(rows[1].title, "Back");
});

test("fitRows caps the title column so other rows keep a usable description", () => {
  const rows = fitRows(
    [
      { title: "a".repeat(60), description: "b".repeat(60) },
      { title: "Auto-submit", description: "off · text lands in the prompt" },
    ],
    40,
  );
  // The long row overruns its own budget and loses its description, but it
  // does not drag the shared column out and starve the row below it.
  assert.equal(rows[0].description, undefined);
  assert.ok(rows[1].description.length >= 8);
});

test("fitRows tolerates empty input and missing titles", () => {
  assert.deepEqual(fitRows([], 80), []);
  assert.deepEqual(fitRows(undefined, 80), []);
  const rows = fitRows([{ value: "a" }, { title: "abc", value: "b" }], 80);
  assert.equal(rows[0].title, "");
  assert.equal(rows[1].title, "abc");
});

test("addBackRow makes navigation visible and keeps its keyboard hint", () => {
  let calls = 0;
  const options = [{ title: "Choice", value: "choice" }];
  assert.equal(
    addBackRow(options, () => calls++, "keep the current choice"),
    options,
  );
  assert.deepEqual(
    { ...options[1], onSelect: undefined },
    {
      title: "← Back",
      description: "keep the current choice",
      footer: BACK_KEY,
      value: "back",
      onSelect: undefined,
    },
  );
  options[1].onSelect();
  assert.equal(calls, 1);
});

test("createMenu wires Back to the active child menu", () => {
  let layer;
  let rendered;
  let closeCurrent;
  let disposed = false;
  let lifecycleDispose;
  let registrations = 0;
  const api = {
    renderer: { width: 120 },
    keymap: {
      registerLayer(value) {
        registrations++;
        layer = value;
        return () => {
          disposed = true;
        };
      },
    },
    lifecycle: {
      onDispose(fn) {
        lifecycleDispose = fn;
      },
    },
    ui: {
      DialogSelect: (props) => props,
      dialog: {
        replace(render, onClose) {
          closeCurrent?.();
          rendered = render();
          closeCurrent = onClose;
        },
        setSize() {},
        clear() {
          const close = closeCurrent;
          closeCurrent = undefined;
          rendered = undefined;
          close?.();
        },
        get open() {
          return Boolean(rendered);
        },
      },
    },
  };
  const menu = createMenu(api);
  createMenu(api);
  assert.equal(registrations, 1);
  let backCalls = 0;
  const childOptions = [{ title: "Choice", value: "choice" }];
  addBackRow(childOptions, () => backCalls++);
  menu({
    title: "Child",
    options: childOptions,
    back: () => backCalls++,
  });

  assert.equal(layer.enabled(), true);
  assert.deepEqual(layer.bindings, [
    { key: BACK_KEY, cmd: "opencode-voice.dialog.back", desc: "Back" },
  ]);
  layer.commands[0].run();
  assert.equal(backCalls, 1);
  assert.equal(rendered.skipFilter, true);
  assert.equal(rendered.flat, true);
  assert.equal(rendered.placeholder, "Filter options…");

  menu({
    title: "Search",
    options: [
      { title: "Choice", value: "choice" },
      { title: "Another choice", value: "another" },
    ],
    filter: true,
  });
  assert.equal(rendered.skipFilter, false);
  api.ui.dialog.clear();
  assert.equal(rendered, undefined);
  assert.equal(layer.enabled(), false);

  const stale = menu.guard();
  assert.equal(stale(), true);

  menu({ title: "Parent", options: [{ title: "Choice", value: "choice" }] });
  assert.equal(stale(), false);
  assert.equal(layer.enabled(), false);
  layer.commands[0].run();
  assert.equal(backCalls, 1);

  let replaced = 0;
  menu({
    title: "Replaced child",
    options: [{ title: "Choice", value: "choice" }],
    back: () => backCalls++,
    onClose: () => replaced++,
  });
  menu({ title: "Replacement", options: [{ title: "Choice", value: "choice" }] });
  assert.equal(replaced, 1);

  let closed = 0;
  menu({
    title: "Child again",
    options: [{ title: "Choice", value: "choice" }],
    back: () => backCalls++,
    onClose: () => closed++,
  });
  const closedRequest = menu.guard();
  api.ui.dialog.clear();
  assert.equal(closedRequest(), false);
  assert.equal(layer.enabled(), false);
  assert.equal(closed, 1);

  lifecycleDispose();
  assert.equal(disposed, true);
});
