// Hold-to-talk detection for push-to-talk keybinds.
//
// OpenCode TUI keybinds fire their command on every key press, and holding a
// key re-fires it at the terminal auto-repeat rate. Key release events are not
// delivered, so a hold is confirmed by observing repeats, and a release is
// inferred when repeats stop arriving (mirroring Claude Code's voice mode).

export const DEFAULT_ARM_MS = 700;
export const DEFAULT_RELEASE_MS = 400;

/**
 * Create a hold detector.
 *
 * press() must be called on every key press (including auto-repeats). The
 * detector decides between a tap (press + release, no repeats) and a hold
 * (repeats arrive), and infers release from a gap in repeats.
 *
 * Callbacks:
 * - onTap()      fired when a press is released without any repeat
 * - onHoldStart() fired once when a hold is confirmed by the first repeat
 * - onHoldEnd()  fired when repeats stop arriving for releaseMs
 */
export function createHoldDetector({
  onHoldStart,
  onHoldEnd,
  onTap,
  armMs = DEFAULT_ARM_MS,
  releaseMs = DEFAULT_RELEASE_MS,
  now = () => Date.now(),
} = {}) {
  const tickMs = Math.max(10, Math.min(50, Math.floor(releaseMs / 4)));
  let state = "idle";
  let armTimer = null;
  let watchTimer = null;
  let lastRepeat = 0;

  function clearTimers() {
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = null;
    }
    if (watchTimer) {
      clearInterval(watchTimer);
      watchTimer = null;
    }
  }

  function watchRelease() {
    watchTimer = setInterval(() => {
      if (state === "holding" && now() - lastRepeat >= releaseMs) {
        clearTimers();
        state = "idle";
        onHoldEnd?.();
      }
    }, tickMs);
  }

  return {
    press() {
      const t = now();
      if (state === "idle") {
        state = "armed";
        armTimer = setTimeout(() => {
          armTimer = null;
          if (state === "armed") {
            state = "idle";
            onTap?.();
          }
        }, armMs);
        return;
      }
      if (state === "armed") {
        clearTimeout(armTimer);
        armTimer = null;
        state = "holding";
        lastRepeat = t;
        onHoldStart?.();
        watchRelease();
        return;
      }
      // holding: this press is an auto-repeat keeping the hold alive
      lastRepeat = t;
    },

    reset() {
      clearTimers();
      state = "idle";
    },

    get state() {
      return state;
    },
  };
}
