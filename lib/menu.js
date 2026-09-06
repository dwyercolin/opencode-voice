// Dialog row layout for the /voice menus.
//
// opencode's DialogSelect renders each option as ONE line - title, then the
// muted description, then a right-aligned footer - with `overflow: hidden`
// and no wrapping. Anything past the panel width is silently clipped
// mid-word, so rows have to be budgeted against the real column count
// instead of hoping the copy is short enough.

// Panel widths opencode uses per dialog size, clamped by the host to
// terminalWidth - 2. Dialogs open at "medium" and must call setSize to widen.
export const DIALOG_WIDTHS = { medium: 60, large: 88, xlarge: 116 };

// Chrome between the panel edge and the row text: the option list's
// paddingLeft/Right of 1, the row's own paddingLeft of 3, and the 1-column
// selection dot, plus a column of slack.
const ROW_CHROME = 8;

/** Usable text columns for one option row at the given size and terminal. */
export function rowWidth(size = "medium", terminalWidth = 0) {
  const panel = DIALOG_WIDTHS[size] ?? DIALOG_WIDTHS.medium;
  const available = terminalWidth > 0 ? Math.min(panel, terminalWidth - 2) : panel;
  return Math.max(24, available - ROW_CHROME);
}

/**
 * Shorten long ids (model names, mic device names) for narrow dialog rows,
 * keeping the tail - that is where the distinguishing part lives.
 */
export function shortLabel(value, max = 42) {
  const text = String(value || "");
  return text.length <= max ? text : `…${text.slice(text.length - (max - 1))}`;
}

/** Clip to `max` columns, marking the cut so it does not read as the full value. */
function clipEnd(text, max) {
  if (max <= 0) return "";
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// Columns a description needs before it says more than "…" does.
const MIN_DESCRIPTION = 16;

/**
 * Lay out option rows to fit one line each: titles padded to a common width
 * so the muted descriptions line up in a column, and each description
 * clipped to whatever space is left after its title and footer. Rows whose
 * description would be squeezed to nothing drop it rather than show a stub.
 */
export function fitRows(options, width) {
  const rows = options ?? [];
  // Titles are unbounded too (model ids, mic device names), so clip them
  // before measuring the column - otherwise one long row both overflows and
  // pads every other title out to its width.
  const titles = rows.map((o) => clipEnd(String(o.title || ""), width));
  // Only rows carrying a description need to line up; nothing follows a bare
  // title, so padding to one long device name would just starve the column.
  // Cap it regardless so the description keeps a readable minimum.
  const described = titles.filter((_, i) => rows[i].description);
  const titleWidth = Math.min(
    Math.max(0, ...described.map((t) => t.length)),
    Math.max(0, width - MIN_DESCRIPTION - 1),
  );
  return rows.map((o, i) => {
    // A title longer than the column runs past it rather than being cut to
    // fit; its own description (if any) is then budgeted against that length.
    const title = titles[i].padEnd(titleWidth);
    if (!o.description) return { ...o, title };
    // The footer is right-aligned in the same row, so it costs space too.
    const footer = o.footer ? String(o.footer).length + 2 : 0;
    const room = width - title.length - 1 - footer;
    const description = room >= 8 ? clipEnd(String(o.description), room) : undefined;
    return { ...o, title, description };
  });
}

/**
 * Open a DialogSelect sized for its content. Menus default to "large" (88
 * columns): the 60-column default clips our two-column rows.
 */
export function createMenu(api) {
  // Present on the opentui renderer; read defensively so a host without it
  // just falls back to the panel width.
  const terminalWidth = () => Number(api?.renderer?.width) || 0;

  return function menu({ title, options, size = "large", current, placeholder, filter = false }) {
    const rows = fitRows(options, rowWidth(size, terminalWidth()));
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect({
        title,
        options: rows,
        current,
        placeholder,
        // Short fixed menus skip the search box, which would otherwise spend
        // the first line filtering four rows.
        skipFilter: !filter,
        renderFilter: filter,
      }),
    );
    // replace() resets the stack to "medium", so this has to come after it.
    api.ui.dialog.setSize?.(size);
  };
}
