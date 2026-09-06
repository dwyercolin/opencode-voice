import assert from "node:assert/strict";
import test from "node:test";

import {
  catalogRowsForProviders,
  countProbeFixes,
  flattenProviderModels,
  isSmallModel,
  mergeModelRows,
  parseListeningPorts,
  rankProbeResults,
  serverModelsToRows,
} from "../lib/cleanup.js";

test("parses listening loopback ports from /proc/net/tcp format", () => {
  const proc = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:D7F8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0",
    "   1: 0100007F:0D48 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346 1 0000000000000000 100 0 0 10 0",
    "   2: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12347 1 0000000000000000 100 0 0 10 0",
  ].join("\n");
  // D7F8=55288, 0D48=3400, 1F40=8000
  assert.deepEqual(
    parseListeningPorts(proc).sort((a, b) => a - b),
    [3400, 8000, 55288],
  );
});

test("ignores non-listening sockets, remote hosts, and garbage lines", () => {
  const proc = [
    "header",
    "   0: 0100007F:D7F8 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 1 1 0", // ESTABLISHED
    "   1: 6C15EA9C:0D48 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 1 0", // non-loopback
    "garbage line",
  ].join("\n");
  assert.deepEqual(parseListeningPorts(proc), []);
});

test("handles empty input", () => {
  assert.deepEqual(parseListeningPorts(""), []);
  assert.deepEqual(parseListeningPorts(null), []);
});

test("isSmallModel matches small names, open-weights sizes, and cheap pricing", () => {
  assert.equal(isSmallModel({ id: "claude-haiku-4-5" }), true);
  assert.equal(isSmallModel({ id: "gpt-4o-mini" }), true);
  assert.equal(isSmallModel({ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" }), true);
  assert.equal(isSmallModel({ id: "qwen3-8b" }), true);
  assert.equal(isSmallModel({ id: "deepseek-chat", cost: { input: 0.27 } }), true);
  // free models ($0/M) count as small
  assert.equal(isSmallModel({ id: "glm-4.5-flash", cost: { input: 0 } }), true);
});

test("isSmallModel rejects large and expensive models", () => {
  assert.equal(isSmallModel({ id: "claude-sonnet-4-5", cost: { input: 3 } }), false);
  assert.equal(isSmallModel({ id: "llama-3.3-70b" }), false);
  // "gemini" contains "mini" but not as a word - must not match
  assert.equal(isSmallModel({ id: "gemini-2.5-pro", cost: { input: 1.25 } }), false);
  assert.equal(isSmallModel(null), false);
  assert.equal(isSmallModel({}), false);
  // unknown pricing (0/undefined) never tags by cost alone
  assert.equal(isSmallModel({ id: "deepseek-chat" }), false);
});

test("flattenProviderModels flattens providers and sorts small models first", () => {
  const providers = [
    {
      id: "anthropic",
      models: {
        "claude-sonnet-4-5": {
          id: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          cost: { input: 3 },
        },
        "claude-haiku-4-5": {
          id: "claude-haiku-4-5",
          name: "Claude Haiku 4.5",
          cost: { input: 1 },
        },
      },
    },
    { id: "ollama", models: [{ id: "qwen3-8b" }] },
    { id: "empty", models: {} },
  ];
  const rows = flattenProviderModels(providers);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["anthropic/claude-haiku-4-5", "ollama/qwen3-8b", "anthropic/claude-sonnet-4-5"],
  );
  assert.equal(rows[0].small, true);
  assert.equal(rows[1].small, true);
  assert.equal(rows[2].small, false);
  assert.equal(rows[1].name, "qwen3-8b"); // name falls back to model id
});

test("flattenProviderModels tolerates missing or malformed input", () => {
  assert.deepEqual(flattenProviderModels(null), []);
  assert.deepEqual(flattenProviderModels([]), []);
  // providers without an id and models without an id are dropped
  assert.deepEqual(
    flattenProviderModels([{ models: { a: { id: "a" } } }, { id: "x", models: { broken: {} } }]),
    [],
  );
});

test("serverModelsToRows maps /v1/models entries to provider-qualified rows", () => {
  const rows = serverModelsToRows([
    { id: "claude-haiku-4-5", owned_by: "anthropic", display_name: "Claude Haiku 4.5" },
    { id: "llama3.2", owned_by: "", name: "Llama 3.2" },
    { id: "", owned_by: "x" },
    "garbage",
  ]);
  assert.deepEqual(rows, [
    { id: "anthropic/claude-haiku-4-5", name: "Claude Haiku 4.5", small: true },
    { id: "llama3.2", name: "Llama 3.2", small: false },
  ]);
  assert.deepEqual(serverModelsToRows(null), []);
  assert.deepEqual(serverModelsToRows({ data: [] }), []);
});

test("catalogRowsForProviders builds rows from a models.dev catalog", () => {
  const catalog = {
    zai: {
      models: {
        "glm-4.5-flash": { id: "glm-4.5-flash", name: "GLM-4.5-Flash", cost: { input: 0 } },
        "glm-4.5": { id: "glm-4.5", name: "GLM-4.5", cost: { input: 0.6 } },
        broken: "not-an-object",
      },
    },
    "zai-coding-plan": { models: { glm: { id: "glm" } } },
    unknown: { models: { a: { id: "a" } } },
  };
  // only the requested provider ids are used; entries without an id fall
  // back to the catalog key
  const rows = catalogRowsForProviders(catalog, ["zai"]);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["zai/glm-4.5-flash", "zai/glm-4.5"],
  );
  assert.equal(rows[0].small, true);
  assert.equal(rows[1].small, true); // $0.6/M input <= $1 threshold
  assert.deepEqual(catalogRowsForProviders(catalog, ["missing"]), []);
  assert.deepEqual(catalogRowsForProviders(null, ["zai"]), []);
  assert.deepEqual(catalogRowsForProviders(catalog, null), []);
});

test("catalogRowsForProviders freeOnly keeps $0 models only", () => {
  const catalog = {
    opencode: {
      models: {
        "glm-4.7-free": { id: "glm-4.7-free", name: "GLM-4.7 Free", cost: { input: 0 } },
        "glm-4.7": { id: "glm-4.7", name: "GLM-4.7", cost: { input: 0.6 } },
        unknown: { id: "unknown", name: "Unknown" },
      },
    },
  };
  const rows = catalogRowsForProviders(catalog, ["opencode"], { freeOnly: true });
  assert.deepEqual(
    rows.map((r) => r.id),
    ["opencode/glm-4.7-free"],
  );
  assert.equal(rows[0].small, true); // free counts as small
});

test("mergeModelRows dedupes by id, keeps the first occurrence, sorts small first", () => {
  const merged = mergeModelRows([
    [{ id: "b/model-b", name: "B", small: false }],
    [
      { id: "b/model-b", name: "B duplicate", small: false },
      { id: "a/model-a", name: "A", small: true },
    ],
    null,
  ]);
  assert.deepEqual(
    merged.map((r) => `${r.id}:${r.name}`),
    ["a/model-a:A", "b/model-b:B"],
  );
  assert.deepEqual(mergeModelRows(null), []);
});

test("countProbeFixes counts the known homophone corrections in probe output", () => {
  assert.equal(countProbeFixes("The JSON file has a boolean flag and the logs are huge."), 3);
  assert.equal(countProbeFixes("The JSON file has a boolean flag."), 2);
  assert.equal(countProbeFixes("um, so the jason file has a bullion flag"), 0);
});

test("rankProbeResults orders by working, then fixes, then latency", () => {
  const ranked = rankProbeResults([
    { id: "fast-dumb", ok: true, fixes: 0, ms: 300 },
    { id: "broken", ok: false, error: "HTTP 401" },
    { id: "slow-good", ok: true, fixes: 3, ms: 4000 },
    { id: "fast-good", ok: true, fixes: 3, ms: 400 },
    { id: "mid", ok: true, fixes: 1, ms: 800 },
  ]);
  assert.deepEqual(
    ranked.map((r) => r.id),
    ["fast-good", "slow-good", "mid", "fast-dumb", "broken"],
  );
  assert.deepEqual(rankProbeResults(null), []);
});
