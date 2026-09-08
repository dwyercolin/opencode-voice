import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { STT_BACKENDS } from "../lib/stt-engines.js";
import {
  buildManagedSttInstallCommand,
  buildManagedSttStopCommand,
  managedRuntimeSupport,
  managedSttEndpoint,
  managedSttRuntime,
  managedSttRuntimeInstalled,
  managedSttRuntimePaths,
  managedSttRuntimeProgress,
} from "../lib/stt-runtimes.js";

test("managed runtimes expose local endpoints and isolated service paths", () => {
  assert.equal(managedSttEndpoint(STT_BACKENDS.OPENAI_COMPATIBLE), "http://127.0.0.1:8000/v1");
  assert.equal(managedSttEndpoint(STT_BACKENDS.FUNASR_LLAMA_CPP), "local://fun-asr");
  assert.equal(managedSttEndpoint(STT_BACKENDS.FUNASR_WEBSOCKET), "");
  assert.equal(managedSttRuntime("unknown"), null);

  const qwen = managedSttRuntimePaths(STT_BACKENDS.OPENAI_COMPATIBLE, "/tmp/stt");
  const fun = managedSttRuntimePaths(STT_BACKENDS.FUNASR_LLAMA_CPP, "/tmp/stt");
  assert.equal(qwen.venv, "/tmp/stt/venv");
  assert.match(qwen.pid, /qwen3-asr\.pid$/);
  assert.match(fun.binary, /llama-funasr-cli$/);
  assert.match(fun.encoder, /funasr-encoder-f16\.gguf$/);
  assert.match(fun.stage, /fun-asr\.stage$/);
});

test("managed runtime progress separates endpoint setup from model weights", () => {
  const fun = managedSttRuntimeProgress(STT_BACKENDS.FUNASR_LLAMA_CPP, "/tmp/stt");
  assert.equal(fun.endpoint.totalBytes, 8_014_474);
  assert.equal(fun.weights.totalBytes, 1_275_804_800);
  assert.equal(fun.weights.files.length, 3);

  const qwen = managedSttRuntimeProgress(STT_BACKENDS.OPENAI_COMPATIBLE, "/tmp/stt");
  assert.equal(qwen.endpoint.totalBytes, 0);
  assert.equal(qwen.weights.totalBytes, 0);
});

test("managed runtime installed state requires the completed artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-voice-runtime-"));
  try {
    const qwen = managedSttRuntimePaths(STT_BACKENDS.OPENAI_COMPATIBLE, root);
    fs.mkdirSync(qwen.dir, { recursive: true });
    fs.mkdirSync(path.join(qwen.venv, "bin"), { recursive: true });
    fs.writeFileSync(qwen.marker, "");
    fs.writeFileSync(qwen.model, "Qwen/Qwen3-ASR-0.6B");
    fs.writeFileSync(qwen.stage, "ready");
    fs.writeFileSync(path.join(qwen.venv, "bin", "qwen-asr-serve"), "");
    assert.equal(
      managedSttRuntimeInstalled(STT_BACKENDS.OPENAI_COMPATIBLE, "Qwen/Qwen3-ASR-0.6B", root),
      true,
    );
    assert.equal(
      managedSttRuntimeInstalled(STT_BACKENDS.OPENAI_COMPATIBLE, "Qwen/Qwen3-ASR-1.7B", root),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed runtime support names the Linux requirement", () => {
  assert.equal(managedRuntimeSupport("linux").supported, true);
  assert.match(managedRuntimeSupport("darwin").message, /Linux/);
});

test("Qwen installer builds a local vLLM service command", () => {
  const command = buildManagedSttInstallCommand({
    backend: STT_BACKENDS.OPENAI_COMPATIBLE,
    model: "Qwen/Qwen3-ASR-1.7B",
    root: "/tmp/stt-runtime",
  });

  assert.match(command, /qwen-asr\[vllm\]/);
  assert.match(command, /torch-c-dlpack-ext/);
  assert.match(command, /qwen-asr-serve/);
  assert.match(command, /Qwen\/Qwen3-ASR-1\.7B/);
  assert.match(command, /127\.0\.0\.1:8000/);
  assert.match(command, /gpu-memory-utilization 0\.6/);
  assert.match(command, /max-model-len 8192/);
  assert.match(command, /--enforce-eager/);
  assert.match(command, /READY=1\n    break/);
  assert.match(command, /\/v1\/models/);
  assert.match(command, /did not become ready within 15 minutes/);
  assert.match(command, /nvidia-smi/);
  assert.match(command, /nohup setsid/);
  assert.match(command, /trap cleanup_started_server EXIT/);
  assert.match(command, /bootstrap\.pypa\.io\/get-pip\.py/);
  assert.match(command, /printf '%s' endpoint/);
  assert.match(command, /printf '%s' weights/);
  assert.match(command, /printf '%s' ready/);
  assert.match(command, /qwen3-asr.*install\.lock/);
  assert.match(command, /9>&-/);
  assert.ok(command.indexOf("READY=1\n    break") < command.lastIndexOf("STARTED_SERVER=0"));
});

test("Fun-ASR installer fetches the official llama.cpp runtime and GGUF models", () => {
  const command = buildManagedSttInstallCommand({
    backend: STT_BACKENDS.FUNASR_LLAMA_CPP,
    model: "FunAudioLLM/Fun-ASR-Nano-2512",
    root: "/tmp/stt-runtime",
  });

  assert.match(command, /runtime-llamacpp-v0\.2\.6/);
  assert.match(command, /llama-funasr-cli/);
  assert.match(command, /Fun-ASR-Nano-GGUF/);
  assert.match(command, /funasr-encoder-f16\.gguf/);
  assert.match(command, /qwen3-0\.6b-q8_0\.gguf/);
  assert.match(command, /fsmn-vad-GGUF/);
  assert.match(command, /FunAudioLLM\/Fun-ASR-Nano-2512/);
  assert.match(command, /779967de1c528c2be966bcc47f246e7d3e6fcdb748d9491263062f4120f35e52/);
  assert.match(command, /printf '%s' endpoint/);
  assert.match(command, /printf '%s' weights/);
  assert.match(command, /printf '%s' ready/);
  assert.match(command, /fun-asr-llama.*install\.lock/);
  assert.doesNotMatch(command, /nvidia-smi/);
});

test("managed installer rejects unsupported backends", () => {
  assert.throws(
    () => buildManagedSttInstallCommand({ backend: "nemo", model: "parakeet-tdt" }),
    /Unsupported managed STT backend/,
  );
});

test("managed shutdown command stops the isolated server group", () => {
  const command = buildManagedSttStopCommand({
    backend: STT_BACKENDS.OPENAI_COMPATIBLE,
    root: "/tmp/stt-runtime",
  });
  assert.match(command, /kill -- -"\$PID"/);
  assert.match(command, /qwen3-asr\.pid/);
});
