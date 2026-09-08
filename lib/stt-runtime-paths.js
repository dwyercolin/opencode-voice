import os from "node:os";
import path from "node:path";

export const STT_RUNTIME_ROOT = path.join(os.homedir(), ".cache", "opencode-voice", "stt");
export const FUNASR_LLAMA_CPP_ENDPOINT = "local://fun-asr";
export const FUNASR_LLAMA_CPP_MODEL = "FunAudioLLM/Fun-ASR-Nano-2512";

export function funAsrLlamaPaths(root = STT_RUNTIME_ROOT) {
  const dir = path.join(root, "fun-asr-llama");
  const modelDir = path.join(dir, "funasr-gguf");
  return {
    dir,
    marker: path.join(dir, ".fun-asr-llama-installed-v1"),
    stage: path.join(dir, "fun-asr.stage"),
    model: path.join(dir, "fun-asr.model"),
    archive: path.join(dir, "funasr-llamacpp-linux-x64.tar.gz"),
    binary: path.join(dir, "llama-funasr-cli"),
    encoder: path.join(modelDir, "funasr-encoder-f16.gguf"),
    decoder: path.join(modelDir, "qwen3-0.6b-q8_0.gguf"),
    vad: path.join(modelDir, "fsmn-vad.gguf"),
  };
}
