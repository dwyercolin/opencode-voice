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
import { resolveOpencodeCleanup } from "./lib/cleanup.js";

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
        if (mode !== "opencode") {
          return { text: null, error: "Cleanup not configured (run /voice setup)" };
        }
        const resolved = await resolveOpencodeCleanup(client, logger);
        const model = kv.get("cleanup.model") || resolved?.model;
        if (!resolved?.endpoint || !model) {
          return {
            text: null,
            error: "opencode server unreachable - cleanup skipped (raw text kept)",
          };
        }
        req.config = { ...req.config, endpoint: resolved.endpoint, model };
      }
      return baseComplete(req);
    };

    const sttCommands = registerSTT(api, kv, complete, options, logger);

    api.command.register(() => sttCommands);
  },
};
