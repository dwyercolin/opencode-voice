// Cleanup-LLM resolution: default the post-dictation cleanup pass to the host
// opencode server so it works with zero configuration - the plugin runs inside
// the opencode TUI process, which serves whatever providers the user has
// authed (including opencode Zen).
//
// The server port is dynamic, so the plugin discovers it by reading its own
// process's listening sockets and probing each localhost listener's /health
// for the opencode signature. Linux-only (/proc); where discovery fails the
// session transport below still reaches the same models, and an explicit
// `endpoint` in tui.json bypasses all of this.

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
 * Unwrap an SDK response. The current generation returns a hey-api
 * `{ data, error }` envelope and reports API errors as a *value*, so reading
 * fields straight off the result silently yields undefined instead of
 * throwing; older generations returned the payload directly. Returns null for
 * an error response. Pure; exported for tests.
 */
export function sdkData(result) {
  if (!result || typeof result !== "object") return null;
  if ("data" in result || "error" in result) {
    return result.error ? null : (result.data ?? null);
  }
  return result;
}

/** Human-readable reason from an SDK `{ error }` envelope. */
function sdkError(result, fallback) {
  const err = result?.error;
  if (!err) return fallback;
  if (typeof err === "string") return err;
  return err.message || err._tag || JSON.stringify(err).slice(0, 120);
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
// Listing "available" models needs several sources, merged and deduped - any
// single one is empty or wrong on some builds:
//   1. api.state.provider - the TUI's own resolved provider list, the same one
//      /models renders. No HTTP call, so it survives builds that serve none of
//      the config routes; passed in by the caller
//   2. client.config.providers() - the canonical route where it exists (some
//      builds answer 404 "Endpoint not supported")
//   3. the host server's OpenAI-compatible /v1/models - what the server will
//      actually serve over /v1
//   4. the models.dev catalog (opencode's own model database) filtered to
//      providers we know the user has - the only place auth-plan models (e.g.
//      zai/glm) exist; servers list them nowhere even though they serve them
//
// The first three are observed, the catalog is inferred, so it goes last:
// merge order decides which row wins for a duplicate id.

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
export function catalogRowsForProviders(catalog, providerIds) {
  const rows = [];
  for (const providerId of providerIds ?? []) {
    const models = catalog?.[providerId]?.models;
    if (!models || typeof models !== "object") continue;
    for (const [key, model] of Object.entries(models)) {
      if (!model || typeof model !== "object") continue;
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

/** Provider ids seen in observed row lists, e.g. ["anthropic"]. Pure. */
export function providerIdsFromRows(rowLists) {
  const ids = new Set();
  for (const list of rowLists ?? []) {
    for (const row of list ?? []) {
      const slash = String(row?.id ?? "").indexOf("/");
      if (slash > 0) ids.add(row.id.slice(0, slash));
    }
  }
  return [...ids];
}

/** Picker rows from the TUI's own provider list (api.state.provider). Pure. */
export function stateProviderRows(state) {
  return Array.isArray(state?.provider) ? flattenProviderModels(state.provider) : [];
}

async function providerRows(client, logger) {
  if (typeof client?.config?.providers !== "function") return [];
  try {
    const data = sdkData(await client.config.providers());
    if (!Array.isArray(data?.providers)) return [];
    return flattenProviderModels(data.providers);
  } catch (err) {
    logger?.log("STT", `providers() failed: ${err.message}`, "debug");
    return [];
  }
}

// The host server's /v1 surface, fetched once per process: the model list
// feeds the picker and the fact that it answered at all is what marks /v1 as
// a usable cleanup transport, so both come from this one request.
const SERVER_MODELS_CACHE = { promise: null };

function loadServerModels(logger) {
  if (!SERVER_MODELS_CACHE.promise) {
    SERVER_MODELS_CACHE.promise = (async () => {
      const baseUrl = await discoverHostServerUrl();
      if (!baseUrl) return { baseUrl: null, rows: [] };
      try {
        const resp = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
        if (!resp.ok) {
          logger?.log("STT", `/v1/models unavailable: HTTP ${resp.status}`, "debug");
          return { baseUrl: null, rows: [] };
        }
        const data = await resp.json();
        return { baseUrl, rows: serverModelsToRows(data?.data) };
      } catch (err) {
        logger?.log("STT", `/v1/models failed: ${err.message}`, "debug");
        return { baseUrl: null, rows: [] };
      }
    })();
  }
  return SERVER_MODELS_CACHE.promise;
}

/**
 * Every model usable for cleanup, from all sources, deduped and sorted
 * small-first. "Usable" per the catalogs; use probeCleanupModels to verify.
 *
 * @param {object} client - the opencode SDK client (api.client)
 * @param {object} [logger]
 * @param {{ state?: object }} [opts] - pass api.state to read its provider list
 */
export async function listCleanupModels(client, logger, { state } = {}) {
  const [configured, served, catalog] = await Promise.all([
    providerRows(client, logger),
    loadServerModels(logger).then((r) => r.rows),
    fetchModelCatalog(logger),
  ]);
  const observed = [stateProviderRows(state), configured, served];
  // Catalog rows are only added for providers that one of the observed lists
  // already named. Some servers answer 200 for an id they do not have,
  // quietly serving a different model instead, so rows for a provider nobody
  // reported would look like working models in the picker and in the probes.
  return mergeModelRows([
    ...observed,
    catalogRowsForProviders(catalog, providerIdsFromRows(observed)),
  ]);
}

// ---- Cleanup model probes ----
//
// "Available" is not "works": catalogs go stale, proxies reroute, free tiers
// rate-limit. The auto-picker fires one tiny cleanup-shaped request at each
// small model and ranks by homophone fixes, then latency.

const PROBE_SYSTEM_PROMPT =
  "You are a speech-to-text normalizer for a coding assistant. Fix punctuation and STT homophones: jason->JSON, bullion->boolean, locks->logs. Output only the cleaned text.";
const PROBE_INPUT = "um, so the jason file has a bullion flag and the locks are huge";
// Enough for the one-sentence answer plus whatever reasoning preamble a
// thinking model spends before it: too tight and a working model returns an
// empty choice and gets scored as broken.
const PROBE_MAX_TOKENS = 512;

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

/** Run `fn` over `items` at most `limit` at a time; results keep input order. */
export async function mapWithConcurrency(items, limit, fn) {
  const list = items ?? [];
  const results = Array.from({ length: list.length });
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    while (next < list.length) {
      const index = next++;
      results[index] = await fn(list[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---- Cleanup transport ----
//
// There are two ways to reach the user's models from inside the TUI process,
// and no build has both:
//
//   /v1/chat/completions   the host server's OpenAI-compatible surface
//   session.prompt         the server's own chat routing, in a throwaway
//                          session - the transport the TUI itself uses
//
// Passthrough builds serve /v1 and answer 404 "Endpoint not supported: POST
// /session"; others gate /v1 behind the active subscription's auth so every
// model fails there while session routing serves them. Guessing wrong makes
// every model in the picker look broken, so both surfaces are probed once per
// process for EXISTENCE - a GET /v1/models, and creating a throwaway session -
// and cleanup then uses whichever answered, preferring /v1 (one request, no
// session litter). Per-model failures are reported per model, not treated as
// the transport being dead.

const TEMP_SESSION_TITLE = "opencode-voice (temporary)";
const TRANSPORT_CACHE = { promise: null };

function splitModelId(id) {
  const slash = String(id).indexOf("/");
  if (slash <= 0) return null;
  return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
}

async function createTempSession(client) {
  // Keep the envelope: the reason for the failure lives in result.error, and
  // sdkData() has already discarded it by the time we know there is no id.
  const result = await client.session.create({ title: TEMP_SESSION_TITLE });
  const id = sdkData(result)?.id;
  if (!id) throw new Error(sdkError(result, "session create returned no id"));
  return id;
}

async function deleteTempSession(client, id) {
  try {
    await client.session.delete({ sessionID: id });
  } catch {}
}

async function sessionRoutesExist(client, logger) {
  if (typeof client?.session?.create !== "function") return false;
  try {
    const created = await client.session.create({ title: TEMP_SESSION_TITLE });
    const id = sdkData(created)?.id;
    if (!id) {
      logger?.log("STT", `session transport unavailable: ${sdkError(created, "no id")}`, "debug");
      return false;
    }
    await deleteTempSession(client, id);
    return true;
  } catch (err) {
    logger?.log("STT", `session transport unavailable: ${err.message}`, "debug");
    return false;
  }
}

/**
 * Which cleanup transports this host actually serves: { v1, session } where
 * v1 is the base URL or null. Detected once per process; pass refresh to
 * re-detect (the "Test again" row does, so fixing auth can take effect
 * without restarting the TUI).
 */
export async function resolveTransport(client, logger, { refresh = false } = {}) {
  if (refresh) {
    TRANSPORT_CACHE.promise = null;
    SERVER_MODELS_CACHE.promise = null;
  }
  if (!TRANSPORT_CACHE.promise) {
    TRANSPORT_CACHE.promise = (async () => {
      const [served, session] = await Promise.all([
        loadServerModels(logger),
        sessionRoutesExist(client, logger),
      ]);
      const transport = { v1: served.baseUrl, session };
      logger?.log(
        "STT",
        `cleanup transports: v1=${transport.v1 ?? "unavailable"} session=${session}`,
        "debug",
      );
      return transport;
    })();
  }
  return TRANSPORT_CACHE.promise;
}

/** Short, human-readable reason for a failed HTTP response. */
async function httpFailure(resp) {
  let detail = "";
  try {
    const body = await resp.text();
    const parsed = JSON.parse(body);
    detail = parsed?.error?.message || parsed?.message || body;
  } catch {}
  detail = String(detail).replace(/\s+/g, " ").trim().slice(0, 60);
  return detail ? `HTTP ${resp.status}: ${detail}` : `HTTP ${resp.status}`;
}

async function completeViaV1(baseUrl, model, system, prompt, { maxTokens, timeoutMs }) {
  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(await httpFailure(resp));
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("empty response");
  return text;
}

// sessionID and the payload are flat siblings here, matching the TUI's own
// call sites. Instructions ride in the message text rather than the body's
// `system` field, which not every SDK generation forwards.
async function completeViaSession(client, model, system, prompt) {
  const modelRef = splitModelId(model);
  if (!modelRef) throw new Error(`unroutable model id: ${model}`);
  const id = await createTempSession(client);
  try {
    const result = await client.session.prompt({
      sessionID: id,
      model: modelRef,
      parts: [{ type: "text", text: system ? `${system}\n\n${prompt}` : prompt }],
    });
    const failure = sdkError(result);
    if (failure) throw new Error(failure);
    const text = (sdkData(result)?.parts ?? [])
      .filter((p) => p?.type === "text")
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) throw new Error("empty response");
    return text;
  } finally {
    await deleteTempSession(client, id);
  }
}

/**
 * One cleanup pass over whichever transport this host serves, /v1 first.
 * Returns { text } or { text: null, error } like the LLM client does.
 */
export async function runCleanup(
  client,
  model,
  system,
  prompt,
  logger,
  { maxTokens = 2048, timeoutMs = 20000 } = {},
) {
  const transport = await resolveTransport(client, logger);
  const failures = [];
  if (transport.v1) {
    try {
      const startedAt = Date.now();
      const text = await completeViaV1(transport.v1, model, system, prompt, {
        maxTokens,
        timeoutMs,
      });
      logger?.log(
        "STT",
        `cleanup ok via /v1 model=${model} chars=${text.length} ms=${Date.now() - startedAt}`,
        "debug",
      );
      return { text };
    } catch (err) {
      failures.push(`/v1: ${err.message}`);
    }
  }
  if (transport.session) {
    try {
      const startedAt = Date.now();
      const text = await completeViaSession(client, model, system, prompt);
      logger?.log(
        "STT",
        `cleanup ok via session model=${model} chars=${text.length} ms=${Date.now() - startedAt}`,
        "debug",
      );
      return { text };
    } catch (err) {
      failures.push(`session: ${err.message}`);
    }
  }
  if (failures.length === 0) {
    return { text: null, error: "no opencode cleanup transport available" };
  }
  const error = failures.join(" · ");
  logger?.log("STT", `cleanup failed model=${model}: ${error}`, "warn");
  return { text: null, error };
}

/**
 * Probe models with one tiny cleanup request each, a few at a time (a burst
 * of parallel requests can itself trip the rate limit being measured).
 * Returns [{ id, name, ok, ms?, fixes?, error? }] in input order; rank with
 * rankProbeResults.
 */
export async function probeCleanupModels(
  client,
  models,
  logger,
  { limit = 8, concurrency = 3, timeoutMs = 25000 } = {},
) {
  const candidates = (models ?? []).filter((m) => m?.id).slice(0, limit);
  return mapWithConcurrency(candidates, concurrency, async (m) => {
    const startedAt = Date.now();
    const result = await runCleanup(
      client,
      m.id,
      PROBE_SYSTEM_PROMPT,
      `Clean up this speech-to-text transcription:\n\n${PROBE_INPUT}`,
      logger,
      { maxTokens: PROBE_MAX_TOKENS, timeoutMs },
    );
    if (!result.text) {
      return { id: m.id, name: m.name, ok: false, error: String(result.error).slice(0, 90) };
    }
    return {
      id: m.id,
      name: m.name,
      ok: true,
      ms: Date.now() - startedAt,
      fixes: countProbeFixes(result.text),
    };
  });
}

/** Cleanup-model candidates from an opencode config object, best first. */
export function configCleanupCandidates(config) {
  // small_model exists for exactly this kind of cheap auxiliary call; the
  // main model is the fallback when the user never set one.
  return [...new Set([config?.small_model, config?.model].filter(Boolean))];
}

/**
 * What cleanup can use on this host: whether a transport exists at all, and
 * the user's own model choices to offer first. `state` is api.state, whose
 * config is already resolved in-process - the /config route is missing on
 * some builds. Returns { available, model, candidates }.
 */
export async function resolveOpencodeCleanup(client, logger, { state } = {}) {
  const transport = await resolveTransport(client, logger);
  const available = Boolean(transport.v1 || transport.session);
  if (!available) {
    logger?.log("STT", "No opencode cleanup transport found", "debug");
  }
  const candidates = configCleanupCandidates(state?.config);
  if (candidates.length === 0 && typeof client?.config?.get === "function") {
    try {
      candidates.push(...configCleanupCandidates(sdkData(await client.config.get())));
    } catch (err) {
      logger?.log("STT", `config.get failed: ${err.message}`, "debug");
    }
  }
  return { available, model: candidates[0] ?? null, candidates };
}
