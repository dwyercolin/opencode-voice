// opencode-voice: Speech-to-text dictation for OpenCode.
//
// STT: Record voice via sox, transcribe through the selected local or remote
// backend, show a live interim transcript in the prompt while talking,
// normalize with an OpenAI-compatible LLM, append to the TUI prompt.
//
// Prerequisites:
//   sox for capture; /voice can install NeMo or a managed Qwen/Fun runtime
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
//   /stt-record            - record via active voice mode, transcribe
//   /stt-submit           - stop recording, transcribe, and submit
//   /stt-stop             - cancel recording
//   /stt-model            - select local or remote STT model
//   /stt-gain             - toggle auto-gain
//   /stt-mic              - select microphone

import { registerSTT } from "./lib/stt.js";
import { createClient } from "./lib/llm-client.js";
import { createLogger } from "./lib/logger.js";
import { resolveOpencodeCleanup, runCleanup } from "./lib/cleanup.js";

export default {
  id: "opencode-voice",
  tui: async (api, options) => {
    const { kv } = api;
    const client = api.client;
    const logger = createLogger(client);
    logger.log("plugin", "Initializing", "debug");
    const { complete: baseComplete } = createClient(options, logger);

    // Migration: "custom" was a runtime endpoint picked in /voice. Its stored
    // endpoint and model mean nothing to the host server, so drop them rather
    // than route cleanup at something no longer read.
    if (kv.get("cleanup.mode") === "custom") {
      logger.log("plugin", "Dropping obsolete custom cleanup endpoint setting", "debug");
      for (const key of [
        "cleanup.mode",
        "cleanup.model",
        "cleanup.endpoint",
        "cleanup.apiKeyEnv",
      ]) {
        kv.set(key, "");
      }
    }

    // Wrap the LLM client so cleanup can run without a configured endpoint:
    // after /voice setup picks "use my opencode models", each call goes
    // through the host server over whichever transport it serves, using the
    // picked model or the user's small_model.
    const complete = async (req) => {
      if (!options?.endpoint) {
        const mode = kv.get("cleanup.mode");
        if (mode === "skip") {
          return { text: null, error: "Cleanup disabled (run /voice setup to enable)" };
        }
        if (mode !== "opencode") {
          return { text: null, error: "Cleanup not configured (run /voice setup)" };
        }
        let model = kv.get("cleanup.model");
        if (!model) {
          const resolved = await resolveOpencodeCleanup(client, logger, { state: api.state });
          model = resolved?.model;
        }
        if (!model) {
          return { text: null, error: "No cleanup model picked (run /voice)" };
        }
        return runCleanup(client, model, req.system, req.prompt, logger, {
          maxTokens: req.config?.maxTokens,
        });
      }
      return baseComplete(req);
    };

    const sttCommands = registerSTT(api, kv, complete, options, logger);

    api.command.register(() => sttCommands);
  },
};
