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

// ---- Cleanup model catalog ----
//
// The /models-style picker lists everything the user has authed in opencode.
// Cleanup is one short call per dictation, so small models are suggested:
// matched by name (haiku/mini/flash/...), by open-weights size (<=14B), or by
// cheap input pricing (models.dev costs are $ per 1M tokens).

const SMALL_NAME_PATTERN = /\b(haiku|mini|flash|nano|lite|small|instant|air)\b/;
const SMALL_PARAMS_PATTERN = /\b(\d{1,2}(?:\.\d+)?)b\b/;
const SMALL_INPUT_COST = 1; // $/1M input tokens; $0 (free) counts as small

/** Heuristic: is this model small/cheap enough to recommend for cleanup? */
export function isSmallModel(model) {
  const label = `${model?.id ?? ""} ${model?.name ?? ""}`.toLowerCase();
  if (SMALL_NAME_PATTERN.test(label)) return true;
  const params = SMALL_PARAMS_PATTERN.exec(label);
  if (params && Number.parseFloat(params[1]) <= 14) return true;
  const inputCost = model?.cost ? Number(model.cost.input) : NaN;
  return Number.isFinite(inputCost) && inputCost <= SMALL_INPUT_COST;
}

/**
 * Flatten a providers() response into picker rows: { id: "provider/model",
 * name, small }, small models first (then by id). Pure; exported for tests.
 */
export function flattenProviderModels(providers) {
  const rows = [];
  for (const provider of providers ?? []) {
    if (!provider?.id) continue;
    const models = Array.isArray(provider.models)
      ? provider.models
      : Object.values(provider.models ?? {});
    for (const model of models) {
      if (!model?.id) continue;
      rows.push({
        id: `${provider.id}/${model.id}`,
        name: model.name || model.id,
        small: isSmallModel(model),
      });
    }
  }
  return rows.sort((a, b) => Number(b.small) - Number(a.small) || a.id.localeCompare(b.id));
}

// ---- Cleanup model discovery ----
//
// Listing "available" models needs three sources, merged and deduped - any
// single one is wrong on some setups:
//   1. client.config.providers() - canonical, but some hosts hide the config
//      routes and the SDK returns the error as a value instead of throwing
//   2. the models.dev catalog (opencode's own model database) filtered to
//      providers the user authed - the only place auth-plan models (e.g.
//      zai/glm) exist; servers list them nowhere even though they serve them
//   3. the host server's OpenAI-compatible /v1/models - always readable, but
//      only lists custom/config providers

const MODELS_DEV_URL = "https://models.dev/api.json";
const MODEL_CATALOG_CACHE = { data: undefined, attempted: false };

async function fetchModelCatalog(logger) {
  if (MODEL_CATALOG_CACHE.attempted) return MODEL_CATALOG_CACHE.data ?? {};
  MODEL_CATALOG_CACHE.attempted = true;
  try {
    const resp = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(4000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    MODEL_CATALOG_CACHE.data = data && typeof data === "object" ? data : {};
  } catch (err) {
    logger?.log("STT", `models.dev catalog unavailable: ${err.message}`, "debug");
  }
  return MODEL_CATALOG_CACHE.data ?? {};
}

/** Map a /v1/models response `data` array to picker rows. Pure; for tests. */
export function serverModelsToRows(data) {
  return (Array.isArray(data) ? data : [])
    .filter((m) => m?.id)
    .map((m) => {
      const name = m.display_name || m.name || m.id;
      return {
        id: m.owned_by ? `${m.owned_by}/${m.id}` : m.id,
        name,
        small: isSmallModel({ id: m.id, name }),
      };
    });
}

/** Build picker rows for the given provider ids from a models.dev catalog. */
export function catalogRowsForProviders(catalog, providerIds, { freeOnly = false } = {}) {
  const rows = [];
  for (const providerId of providerIds ?? []) {
    const models = catalog?.[providerId]?.models;
    if (!models || typeof models !== "object") continue;
    for (const [key, model] of Object.entries(models)) {
      if (!model || typeof model !== "object") continue;
      if (freeOnly) {
        const input = Number(model.cost?.input);
        if (!(Number.isFinite(input) && input <= 0)) continue;
      }
      rows.push({
        id: `${providerId}/${model.id || key}`,
        name: model.name || model.id || key,
        small: isSmallModel(model),
      });
    }
  }
  return rows;
}

/** Dedupe rows by id (first list wins), small models first, then by id. */
export function mergeModelRows(rowLists) {
  const seen = new Set();
  const rows = [];
  for (const list of rowLists ?? []) {
    for (const row of list ?? []) {
      if (!row?.id || seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
  }
  return rows.sort((a, b) => Number(b.small) - Number(a.small) || a.id.localeCompare(b.id));
}

async function providerRows(client, logger) {
  if (typeof client?.config?.providers !== "function") return [];
  try {
    const provs = await client.config.providers();
    if (!provs || provs.error || !Array.isArray(provs.providers)) return [];
    return flattenProviderModels(provs.providers);
  } catch (err) {
    logger?.log("STT", `providers() failed: ${err.message}`, "debug");
    return [];
  }
}

async function authedProviderIds(client, logger) {
  const auth = client?.auth ?? client?._auth;
  if (typeof auth?.list !== "function") return [];
  try {
    const result = await auth.list();
    if (!Array.isArray(result) || result.error) return [];
    return result
      .map((e) => (typeof e === "string" ? e : (e?.id ?? e?.providerID ?? e?.provider)))
      .filter(Boolean);
  } catch (err) {
    logger?.log("STT", `auth list failed: ${err.message}`, "debug");
    return [];
  }
}

async function serverRows(logger) {
  const baseUrl = await discoverHostServerUrl();
  if (!baseUrl) return [];
  try {
    const resp = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return serverModelsToRows(data?.data);
  } catch (err) {
    logger?.log("STT", `/v1/models failed: ${err.message}`, "debug");
    return [];
  }
}

/**
 * Every model usable for cleanup, from all three sources, deduped and sorted
 * small-first. "Usable" per the catalogs; use probeCleanupModels to verify.
 */
export async function listCleanupModels(client, logger) {
  const [providers, catalog, authIds, served] = await Promise.all([
    providerRows(client, logger),
    fetchModelCatalog(logger),
    authedProviderIds(client, logger),
    serverRows(logger),
  ]);
  // Zen (the built-in "opencode" provider) serves its free models even
  // without zen auth - the same free rows the /models menu shows - so always
  // offer them; authed users get zen's full catalog via authIds instead.
  const zenFreeRows = authIds.includes("opencode")
    ? []
    : catalogRowsForProviders(catalog, ["opencode"], { freeOnly: true });
  return mergeModelRows([
    providers,
    catalogRowsForProviders(catalog, authIds),
    zenFreeRows,
    served,
  ]);
}

// ---- Cleanup model probes ----
//
// "Available" is not "works": catalogs go stale, proxies reroute, free tiers
// rate-limit. The auto-picker fires one tiny cleanup-shaped request at each
// small model (in parallel) and ranks by homophone fixes, then latency.

const PROBE_SYSTEM_PROMPT =
  "You are a speech-to-text normalizer for a coding assistant. Fix punctuation and STT homophones: jason->JSON, bullion->boolean, locks->logs. Output only the cleaned text.";
const PROBE_INPUT = "um, so the jason file has a bullion flag and the locks are huge";

/** Count how many of the probe's known homophone fixes appear in the output. */
export function countProbeFixes(text) {
  return [/json/i, /boolean/i, /logs/i].reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
}

/** Sort probe results: working first, most fixes, then lowest latency. */
export function rankProbeResults(results) {
  return [...(results ?? [])].sort((a, b) => {
    if (Boolean(a.ok) !== Boolean(b.ok)) return a.ok ? -1 : 1;
    if (!a.ok) return 0;
    if (a.fixes !== b.fixes) return b.fixes - a.fixes;
    return a.ms - b.ms;
  });
}

async function probeOneModel(baseUrl, model, timeoutMs) {
  const startedAt = Date.now();
  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 100,
      messages: [
        { role: "system", content: PROBE_SYSTEM_PROMPT },
        { role: "user", content: `Clean up this speech-to-text transcription:\n\n${PROBE_INPUT}` },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) return { ok: false, error: "empty response" };
  return { ok: true, ms: Date.now() - startedAt, fixes: countProbeFixes(text) };
}

/**
 * Probe each model with one tiny cleanup request, in parallel. Returns
 * [{ id, name, ok, ms?, fixes?, error? }] in input order; rank with
 * rankProbeResults.
 */
export async function probeCleanupModels(
  baseUrl,
  models,
  logger,
  { limit = 6, timeoutMs = 8000 } = {},
) {
  const candidates = (models ?? []).filter((m) => m?.id).slice(0, limit);
  return Promise.all(
    candidates.map(async (m) => {
      try {
        const result = await probeOneModel(baseUrl, m.id, timeoutMs);
        return { id: m.id, name: m.name, ...result };
      } catch (err) {
        logger?.log("STT", `probe ${m.id} failed: ${err.message}`, "debug");
        return { id: m.id, name: m.name, ok: false, error: err.message };
      }
    }),
  );
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
