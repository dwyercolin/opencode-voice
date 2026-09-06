# Notes

## Local model support for cleanup (researched 2026-09-06, not implemented)

Users with local LLM runtimes that are NOT wired into opencode as providers
are invisible to the cleanup model picker. Recap of findings for whenever we
pick this up:

### What the picker covers today

- Local server configured as an opencode provider (custom provider in
  `opencode.json`) → flows in via the host server's `/v1/models` source.
  Ollama's official opencode integration writes this config automatically.
- Deliberate local cleanup via tui.json `endpoint`/`model` → already
  supported (see README "Fully local / offline cleanup").

### The gap

Ollama/LM Studio/llama.cpp/vLLM installed but not registered in opencode.
Nothing in opencode knows they exist; the plugin would probe localhost
itself. All of them expose unauthenticated OpenAI-compatible endpoints:

| Runtime                | Default endpoint            | Notes                            |
| ---------------------- | --------------------------- | -------------------------------- |
| Ollama (most common)   | `http://localhost:11434/v1` | not in models.dev; always custom |
| LM Studio              | `http://127.0.0.1:1234/v1`  | GUI users                        |
| llama.cpp llama-server | `http://127.0.0.1:8080/v1`  |                                  |
| vLLM / NIM             | `http://localhost:8000/v1`  |                                  |

`GET /v1/models` on each lists the models actually pulled/loaded, and
anything listed is directly callable at `<base>/v1/chat/completions` - no
opencode host server involved.

### Reusable pieces already in place

- `probeCleanupModels(baseUrl, models, logger)` in `lib/cleanup.js` is
  endpoint-generic: it works against any OpenAI-compatible base URL, so
  probing/ranking local models needs no new machinery.
- `serverModelsToRows()` maps a `/v1/models` response to picker rows
  (no cost data from local servers → small-tagging falls back to the
  name/params heuristic in `isSmallModel`).

### Open design questions

- Where a local pick persists: today `index.js` routes cleanup through the
  discovered host server unless tui.json pins an endpoint; a local selection
  needs a per-selection endpoint (e.g. `cleanup.endpoint` in kv) and the
  resolver must honor it.
- Which ports to scan, timeout budget, and whether to ask before probing.
