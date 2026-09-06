// Cleanup-LLM resolution: default the post-dictation cleanup pass to the host
// opencode server so it works with zero configuration - the plugin runs inside
// the opencode TUI process, which hosts an OpenAI-compatible /v1 endpoint
// backed by whatever providers the user has authed (including opencode Zen).
//
// The server port is dynamic, so the plugin discovers it by reading its own
// process's listening sockets and probing each localhost listener's /health
// for the opencode signature. Linux-only (/proc); elsewhere or when discovery
// fails, an explicit `endpoint` in tui.json is required.

import fs from "node:fs";

const DISCOVERY_CACHE = { url: undefined, attempted: false };

/**
 * Parse /proc/net/tcp content into listening TCP ports.
 * Pure; exported for tests.
 */
export function parseListeningPorts(procNetTcp) {
  const ports = new Set();
  for (const line of (procNetTcp || "").split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    if (cols[3] !== "0A") continue; // TCP_LISTEN
    const local = cols[1];
    const ip = local.slice(0, local.indexOf(":"));
    // 0100007F = 127.0.0.1, 00000000 = 0.0.0.0 (includes loopback)
    if (ip !== "0100007F" && ip !== "00000000") continue;
    ports.add(Number.parseInt(local.slice(local.indexOf(":") + 1), 16));
  }
  return [...ports];
}

function readProcNetTcp() {
  try {
    return fs.readFileSync("/proc/self/net/tcp", "utf8");
  } catch {
    return "";
  }
}

async function looksLikeOpencodeServer(baseUrl) {
  try {
    const resp = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(400) });
    if (!resp.ok) return false;
    const data = await resp.json();
    return (
      data?.status === "healthy" &&
      typeof data?.version === "string" &&
      (data.auth != null || data.plugin != null || data.claudeExecutable != null)
    );
  } catch {
    return false;
  }
}

/**
 * Find the opencode server this plugin is hosted by. Returns the base URL
 * (e.g. "http://127.0.0.1:3456") or null. Cached per process.
 */
export async function discoverHostServerUrl() {
  if (DISCOVERY_CACHE.attempted) return DISCOVERY_CACHE.url ?? null;
  DISCOVERY_CACHE.attempted = true;
  const ports = parseListeningPorts(readProcNetTcp());
  for (const port of ports.slice(0, 10)) {
    const baseUrl = `http://127.0.0.1:${port}`;
    if (await looksLikeOpencodeServer(baseUrl)) {
      DISCOVERY_CACHE.url = baseUrl;
      return baseUrl;
    }
  }
  return null;
}

/**
 * Resolve cleanup endpoint/model from the host server. Prefers the user's
 * opencode `small_model` (built for cheap auxiliary work; opencode resolves
 * it to a cheaper provider model or the main model when unset), falling back
 * to the main `model` and the provider defaults map. Returns
 * { endpoint, model, candidates } or null when the server cannot be found.
 */
export async function resolveOpencodeCleanup(client, logger) {
  const baseUrl = await discoverHostServerUrl();
  if (!baseUrl) {
    logger?.log("STT", "Host server discovery failed", "debug");
    return null;
  }
  const candidates = [];
  try {
    if (typeof client?.config?.get === "function") {
      const cfg = await client.config.get();
      if (cfg?.small_model) candidates.push(cfg.small_model);
      if (cfg?.model) candidates.push(cfg.model);
    }
    if (candidates.length === 0 && typeof client?.config?.providers === "function") {
      const provs = await client.config.providers();
      const defaults = Object.values(provs?.default || {});
      candidates.push(...defaults.slice(0, 2));
    }
  } catch (err) {
    logger?.log("STT", `cleanup model resolution failed: ${err.message}`, "debug");
  }
  const unique = [...new Set(candidates.filter(Boolean))];
  if (unique.length === 0) {
    return { endpoint: `${baseUrl}/v1`, model: null, candidates: [] };
  }
  return { endpoint: `${baseUrl}/v1`, model: unique[0], candidates: unique };
}
