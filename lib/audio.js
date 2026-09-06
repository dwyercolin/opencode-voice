// Audio level helpers: measure recording loudness and auto-boost quiet input.

import { spawn } from "node:child_process";

// Speech recorded at a healthy level sits around -18 dB RMS; below -32 dB the
// models start missing words. Boost toward the target, capped to avoid
// amplifying room noise into mush.
export const AUTOGAIN_TARGET_DB = -18;
export const AUTOGAIN_MIN_RMS_DB = -32;
export const AUTOGAIN_MAX_BOOST_DB = 28;

/**
 * Pure decision: how much gain (dB) to apply given the measured RMS level.
 * Returns 0 when the input is already loud enough or the measurement is bad.
 */
export function computeAutoGainDb(
  rmsDb,
  {
    targetDb = AUTOGAIN_TARGET_DB,
    minRmsDb = AUTOGAIN_MIN_RMS_DB,
    maxBoostDb = AUTOGAIN_MAX_BOOST_DB,
  } = {},
) {
  if (rmsDb == null || !Number.isFinite(rmsDb)) return 0;
  if (rmsDb >= minRmsDb) return 0;
  return Math.min(maxBoostDb, Math.round(targetDb - rmsDb));
}

/**
 * Parse the "RMS lev dB" value from `sox <file> -n stats` output.
 */
export function parseRmsDb(statsOutput) {
  const m = /RMS lev dB\s+(-?\d+(?:\.\d+)?)/.exec(statsOutput || "");
  return m ? Number.parseFloat(m[1]) : null;
}

function runCommand(cmd, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.stdout.on("data", (c) => (stdout += c.toString()));
    proc.stderr.on("data", (c) => (stderr += c.toString()));
    proc.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr });
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

/** Measure a WAV's RMS level in dB via sox. Returns null on failure. */
export async function measureRmsDb(file) {
  const result = await runCommand("sox", [file, "-n", "stats"]);
  if (!result.ok) return null;
  return parseRmsDb(result.stderr);
}

/**
 * Boost a WAV by gainDb with a lookahead limiter (no clipping).
 * Returns true on success.
 */
export async function boostWavGain(src, dst, gainDb) {
  const result = await runCommand("sox", [src, dst, "gain", "-l", String(gainDb)]);
  return result.ok;
}

/**
 * Measure src and, if it is too quiet, write a boosted copy to dst.
 * Returns { file, gainDb, rmsDb } - file is dst when boosted, src otherwise.
 */
export async function applyAutoGain(src, dst, { enabled = true, logger } = {}) {
  if (!enabled) return { file: src, gainDb: 0, rmsDb: null };
  const rmsDb = await measureRmsDb(src);
  const gainDb = computeAutoGainDb(rmsDb);
  if (gainDb <= 0) return { file: src, gainDb: 0, rmsDb };
  const ok = await boostWavGain(src, dst, gainDb);
  if (!ok) {
    logger?.log("STT", `Auto-gain boost failed for ${src}`, "warn");
    return { file: src, gainDb: 0, rmsDb };
  }
  logger?.log("STT", `Auto-gain applied +${gainDb}dB (measured ${rmsDb}dB RMS)`, "debug");
  return { file: dst, gainDb, rmsDb };
}
