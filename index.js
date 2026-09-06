// opencode-voice: Speech-to-text dictation for OpenCode.
//
// STT: Record voice via sox, transcribe locally with nemo-speech, show a live
// interim transcript in the prompt while talking, normalize with an
// OpenAI-compatible LLM, append to the TUI prompt.
//
// Prerequisites:
//   sox for capture; nemo-speech for transcription (/voice installs it)
//
// Configuration via tui.json plugin options (all optional - /voice setup can
// configure the rest at runtime):
//   ["opencode-voice", { "endpoint": "...", "model": "...", "apiKeyEnv": "..." }]
//
// When no endpoint is configured, the cleanup pass defaults to the host
// opencode server (the user's own models, including free opencode Zen ones)
// after running /voice setup.
//
// Runtime state (model, mic, voice mode, cleanup mode) via api.kv.
//
// Commands:
//   /voice                - setup wizard (first run), then the settings hub
//   /stt-record (ctrl+r)  - record via active voice mode, transcribe
//   /stt-submit           - stop recording, transcribe, and submit
//   /stt-stop             - cancel recording
//   /stt-model            - select nemo-speech model
//   /stt-gain             - toggle auto-gain
//   /stt-mic              - select microphone

import { registerSTT } from "./lib/stt.js";
import { createClient } from "./lib/llm-client.js";
import { createLogger } from "./lib/logger.js";
import { resolveOpencodeCleanup, runCleanupViaSession } from "./lib/cleanup.js";

export default {
  id: "opencode-voice",
  tui: async (api, options) => {
    const { kv } = api;
    const client = api.client;
    const logger = createLogger(client);
    logger.log("plugin", "Initializing", "debug");
    const { complete: baseComplete } = createClient(options, logger);

    // Wrap the LLM client so cleanup can run without a configured endpoint:
    // after /voice setup picks "use my opencode models", each call resolves
    // the host server URL (dynamic port) and the user's small_model on the fly.
    const complete = async (req) => {
      if (!options?.endpoint) {
        const mode = kv.get("cleanup.mode");
        if (mode === "skip") {
          return { text: null, error: "Cleanup disabled (run /voice setup to enable)" };
        }
        if (mode === "custom") {
          // Picked at runtime via /voice: a direct OpenAI-compatible endpoint
          // that bypasses the host server entirely.
          const endpoint = kv.get("cleanup.endpoint");
          const model = kv.get("cleanup.model");
          if (!endpoint || !model) {
            return { text: null, error: "Custom cleanup endpoint not configured (run /voice)" };
          }
          req.config = {
            ...req.config,
            endpoint,
            model,
            apiKeyEnv: kv.get("cleanup.apiKeyEnv") || undefined,
          };
          return baseComplete(req);
        }
        if (mode !== "opencode") {
          return { text: null, error: "Cleanup not configured (run /voice setup)" };
        }
        const model = kv.get("cleanup.model");
        // Zen ("opencode/*") models route through the server's own chat
        // (session.prompt, the same transport the TUI uses): the OpenAI-compat
        // /v1 endpoint is auth-gated on some hosts and 429s them even though
        // the server itself serves them fine. Everything else keeps /v1.
        if (model && model.startsWith("opencode/")) {
          return runCleanupViaSession(client, model, req.system, req.prompt, logger);
        }
        const resolved = await resolveOpencodeCleanup(client, logger);
        const endpointModel = model || resolved?.model;
        if (!resolved?.endpoint || !endpointModel) {
          return {
            text: null,
            error: "opencode server unreachable - cleanup skipped (raw text kept)",
          };
        }
        req.config = { ...req.config, endpoint: resolved.endpoint, model: endpointModel };
      }
      return baseComplete(req);
    };

    const sttCommands = registerSTT(api, kv, complete, options, logger);

    api.command.register(() => sttCommands);
  },
};
