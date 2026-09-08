// Managed local runtimes for STT backends whose model servers are not part of
// the plugin process. The installer is intentionally shell-based: model
// packages and GPU runtimes stay outside the plugin's npm dependency tree.

import fs from "node:fs";
import path from "node:path";

import { STT_BACKENDS } from "./stt-engines.js";
import {
  FUNASR_LLAMA_CPP_ENDPOINT,
  FUNASR_LLAMA_CPP_MODEL,
  funAsrLlamaPaths,
  STT_RUNTIME_ROOT,
} from "./stt-runtime-paths.js";

export { STT_RUNTIME_ROOT } from "./stt-runtime-paths.js";

const RUNTIMES = {
  [STT_BACKENDS.OPENAI_COMPATIBLE]: {
    id: "qwen3-asr",
    endpoint: "http://127.0.0.1:8000/v1",
    port: 8000,
    packageSpec: '"qwen-asr[vllm]" torch-c-dlpack-ext',
    executable: "qwen-asr-serve",
    installMarker: ".qwen3-asr-installed-v2",
    stageFile: "qwen3-asr.stage",
    modelFile: "qwen3-asr.model",
    pidFile: "qwen3-asr.pid",
    logFile: "qwen3-asr.log",
  },
  [STT_BACKENDS.FUNASR_LLAMA_CPP]: {
    id: "fun-asr-llama",
    endpoint: FUNASR_LLAMA_CPP_ENDPOINT,
    mode: "executable",
    installMarker: ".fun-asr-llama-installed-v1",
    modelFile: "fun-asr.model",
    model: FUNASR_LLAMA_CPP_MODEL,
  },
};

const MANAGED_GPU_MEMORY_UTILIZATION = 0.6;

export function managedSttRuntime(backend) {
  return RUNTIMES[backend] || null;
}

export function managedSttModelSupported(backend, model) {
  const runtime = managedSttRuntime(backend);
  return Boolean(runtime && (!runtime.model || runtime.model === model));
}

export function managedSttEndpoint(backend) {
  return managedSttRuntime(backend)?.endpoint || "";
}

export function managedSttRuntimePaths(backend, root = STT_RUNTIME_ROOT) {
  const runtime = managedSttRuntime(backend);
  if (!runtime) return null;
  if (runtime.mode === "executable") return funAsrLlamaPaths(root);
  const dir = path.join(root, runtime.id);
  return {
    dir,
    venv: path.join(root, "venv"),
    port: runtime.port,
    marker: path.join(dir, runtime.installMarker),
    stage: path.join(dir, runtime.stageFile),
    model: path.join(dir, runtime.modelFile),
    pid: path.join(dir, runtime.pidFile),
    log: path.join(dir, runtime.logFile),
    server: runtime.serverFile ? path.join(dir, runtime.serverFile) : null,
  };
}

export function managedSttRuntimeProgress(backend, root = STT_RUNTIME_ROOT) {
  const runtime = managedSttRuntime(backend);
  const paths = managedSttRuntimePaths(backend, root);
  if (!runtime || !paths) return null;
  if (runtime.mode === "executable") {
    return {
      endpoint: { files: [paths.archive], totalBytes: 8_014_474 },
      weights: {
        files: [paths.encoder, paths.decoder, paths.vad],
        totalBytes: 1_275_804_800,
      },
    };
  }
  return {
    endpoint: { files: [], totalBytes: 0 },
    weights: { files: [], totalBytes: 0 },
  };
}

function readableFile(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isRunning(pidFile) {
  const pid = Number(readableFile(pidFile));
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function managedSttRuntimeInstalled(backend, model, root = STT_RUNTIME_ROOT) {
  const runtime = managedSttRuntime(backend);
  const paths = managedSttRuntimePaths(backend, root);
  if (!runtime || !paths || !managedSttModelSupported(backend, model)) return false;
  if (!isFile(paths.marker) || readableFile(paths.model) !== model) return false;
  if (runtime.mode === "executable") {
    return [paths.binary, paths.encoder, paths.decoder, paths.vad].every(isFile);
  }
  if (!isFile(path.join(paths.venv, "bin", runtime.executable))) return false;
  return readableFile(paths.stage) === "ready" || isRunning(paths.pid);
}

export function managedRuntimeSupport(platform = process.platform) {
  if (platform !== "linux") {
    return {
      supported: false,
      message: "Managed Qwen3-ASR and Fun-ASR llama.cpp runtimes currently require Linux",
    };
  }
  return { supported: true, message: "" };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function stopPidScript(pidFile) {
  const file = shellQuote(pidFile);
  return `if [ -r ${file} ]; then
  PID=$(cat ${file} 2>/dev/null || true)
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill -- -"$PID" 2>/dev/null || kill "$PID" 2>/dev/null || true
    for WAIT in $(seq 1 30); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 1
    done
  fi
  rm -f ${file}
fi`;
}

function waitReadyScript(runtime, paths) {
  const pidFile = shellQuote(paths.pid);
  const logFile = shellQuote(paths.log);
  const probe =
    runtime.id === "qwen3-asr"
      ? `curl -fsS --max-time 2 ${shellQuote(`${runtime.endpoint}/models`)} >/dev/null 2>&1`
      : `(echo >/dev/tcp/127.0.0.1/${runtime.port}) >/dev/null 2>&1`;
  return `READY=0
for WAIT in $(seq 1 900); do
  PID=$(cat ${pidFile} 2>/dev/null || true)
  if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
    echo "Managed ${runtime.id} server exited during startup"
    tail -n 40 ${logFile} 2>/dev/null || true
    exit 1
  fi
  if ${probe}; then
    READY=1
    break
  fi
  sleep 1
done
if [ "$READY" != 1 ]; then
  echo "Managed ${runtime.id} server did not become ready within 15 minutes"
  tail -n 40 ${logFile} 2>/dev/null || true
  exit 1
fi`;
}

function buildFunAsrLlamaInstallCommand({ model, root, paths }) {
  const rootQ = shellQuote(root);
  const dirQ = shellQuote(paths.dir);
  const archiveQ = shellQuote(paths.archive);
  const binaryQ = shellQuote(paths.binary);
  const modelQ = shellQuote(model);
  const markerQ = shellQuote(paths.marker);
  const modelFileQ = shellQuote(paths.model);
  const modelDirQ = shellQuote(path.dirname(paths.encoder));
  const encoderQ = shellQuote(paths.encoder);
  const decoderQ = shellQuote(paths.decoder);
  const vadQ = shellQuote(paths.vad);
  const stageQ = shellQuote(paths.stage);
  const archiveUrl = shellQuote(
    "https://github.com/modelscope/FunASR/releases/download/runtime-llamacpp-v0.2.6/funasr-llamacpp-linux-x64.tar.gz",
  );
  const encoderUrl = shellQuote(
    "https://huggingface.co/FunAudioLLM/Fun-ASR-Nano-GGUF/resolve/main/funasr-encoder-f16.gguf?download=true",
  );
  const decoderUrl = shellQuote(
    "https://huggingface.co/FunAudioLLM/Fun-ASR-Nano-GGUF/resolve/main/qwen3-0.6b-q8_0.gguf?download=true",
  );
  const vadUrl = shellQuote(
    "https://huggingface.co/FunAudioLLM/fsmn-vad-GGUF/resolve/main/fsmn-vad.gguf?download=true",
  );
  return `set -eu
command -v curl >/dev/null 2>&1 || { echo "curl is required"; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "tar is required"; exit 1; }
command -v sha256sum >/dev/null 2>&1 || { echo "sha256sum is required"; exit 1; }
command -v flock >/dev/null 2>&1 || { echo "flock is required"; exit 1; }
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) echo "The managed Fun-ASR llama.cpp runtime currently supports Linux x86_64 only"; exit 1 ;;
esac
mkdir -p ${rootQ} ${dirQ} ${modelDirQ}
exec 9>${dirQ}/install.lock
flock -x 9
printf '%s' endpoint > ${stageQ}
download_file() {
  URL="$1"
  DEST="$2"
  PART="$DEST.partial"
  if [ -s "$DEST" ]; then return; fi
  if [ -s "$PART" ]; then
    curl -fL --retry 3 --retry-delay 2 -C - "$URL" -o "$PART"
  else
    curl -fL --retry 3 --retry-delay 2 "$URL" -o "$PART"
  fi
  mv "$PART" "$DEST"
}
if [ ! -x ${binaryQ} ]; then
  download_file ${archiveUrl} ${archiveQ}
  (cd ${dirQ} && printf '%s  funasr-llamacpp-linux-x64.tar.gz\n' '779967de1c528c2be966bcc47f246e7d3e6fcdb748d9491263062f4120f35e52' | sha256sum -c -)
  tar -xzf ${archiveQ} -C ${dirQ} --strip-components=1
  chmod +x ${binaryQ}
fi
printf '%s' weights > ${stageQ}
download_file ${encoderUrl} ${encoderQ}
download_file ${decoderUrl} ${decoderQ}
download_file ${vadUrl} ${vadQ}
printf '%s' ${modelQ} > ${modelFileQ}
touch ${markerQ}
printf '%s' ready > ${stageQ}`;
}

/**
 * Build the one-shot installer used by the setup job. It downloads the
 * selected runtime and model files, then leaves them ready for transcription.
 */
export function buildManagedSttInstallCommand({ backend, model, root = STT_RUNTIME_ROOT }) {
  const runtime = managedSttRuntime(backend);
  if (!runtime) throw new Error(`Unsupported managed STT backend: ${backend}`);
  if (!model) throw new Error("A managed STT model is required");
  if (!managedSttModelSupported(backend, model)) {
    throw new Error(`${model} does not have a managed ${runtime.id} runtime`);
  }

  const paths = managedSttRuntimePaths(backend, root);
  if (runtime.mode === "executable") {
    return buildFunAsrLlamaInstallCommand({ model, root, paths });
  }
  const rootQ = shellQuote(root);
  const venvQ = shellQuote(paths.venv);
  const dirQ = shellQuote(paths.dir);
  const markerQ = shellQuote(paths.marker);
  const modelFileQ = shellQuote(paths.model);
  const pidFileQ = shellQuote(paths.pid);
  const logFileQ = shellQuote(paths.log);
  const stageFileQ = shellQuote(paths.stage);
  const modelQ = shellQuote(model);
  const packageInstall = runtime.packageSpec;
  const install = `"$VENV/bin/qwen-asr-serve"`;
  const launchArgs = `${modelQ} --host 127.0.0.1 --port ${runtime.port} --gpu-memory-utilization ${MANAGED_GPU_MEMORY_UTILIZATION} --max-model-len 8192 --enforce-eager`;

  return `set -eu
command -v python3 >/dev/null 2>&1 || { echo "python3 is required"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required"; exit 1; }
command -v setsid >/dev/null 2>&1 || { echo "setsid is required"; exit 1; }
command -v flock >/dev/null 2>&1 || { echo "flock is required"; exit 1; }
command -v nvidia-smi >/dev/null 2>&1 || { echo "nvidia-smi is required for the managed GPU runtime"; exit 1; }
nvidia-smi >/dev/null 2>&1 || { echo "NVIDIA CUDA is not available"; exit 1; }
STARTED_SERVER=0
cleanup_started_server() {
  if [ "$STARTED_SERVER" = 1 ] && [ -r ${pidFileQ} ]; then
    PID=$(cat ${pidFileQ} 2>/dev/null || true)
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      kill -- -"$PID" 2>/dev/null || kill "$PID" 2>/dev/null || true
    fi
    rm -f ${pidFileQ}
  fi
}
trap 'exit 143' TERM INT
trap cleanup_started_server EXIT
mkdir -p ${rootQ} ${dirQ}
exec 9>${dirQ}/install.lock
flock -x 9
printf '%s' endpoint > ${stageFileQ}
VENV=${venvQ}
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
fi
if ! "$VENV/bin/python" -m pip --version >/dev/null 2>&1; then
  curl -fsSL https://bootstrap.pypa.io/get-pip.py | "$VENV/bin/python"
fi
PYTHON_VERSION=$("$VENV/bin/python" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
PYTHON_INCLUDE=$("$VENV/bin/python" -c 'import sysconfig; print(sysconfig.get_path("include"))')
if [ ! -f "$PYTHON_INCLUDE/Python.h" ]; then
  command -v apt-get >/dev/null 2>&1 || { echo "Python.h is missing; install the Python development headers for $PYTHON_VERSION"; exit 1; }
  command -v dpkg-deb >/dev/null 2>&1 || { echo "dpkg-deb is required to bootstrap Python development headers"; exit 1; }
  PYTHON_DEV_DIR=${rootQ}/python-dev
  mkdir -p "$PYTHON_DEV_DIR"
  if [ ! -f "$PYTHON_DEV_DIR/usr/include/python$PYTHON_VERSION/Python.h" ]; then
    (
      cd "$PYTHON_DEV_DIR"
      apt-get download "libpython$PYTHON_VERSION-dev"
      for DEB in *.deb; do
        dpkg-deb -x "$DEB" "$PYTHON_DEV_DIR"
      done
      rm -f -- *.deb
    )
  fi
  if [ ! -f "$PYTHON_DEV_DIR/usr/include/python$PYTHON_VERSION/Python.h" ]; then
    echo "Could not bootstrap Python.h for Python $PYTHON_VERSION"
    exit 1
  fi
  MULTIARCH=$(dpkg-architecture -qDEB_HOST_MULTIARCH 2>/dev/null || true)
  CPATH="$PYTHON_DEV_DIR/usr/include/python$PYTHON_VERSION:$PYTHON_DEV_DIR/usr/include"
  if [ -n "$MULTIARCH" ]; then
    CPATH="$CPATH:$PYTHON_DEV_DIR/usr/include/$MULTIARCH/python$PYTHON_VERSION"
  fi
  export CPATH
fi
if [ ! -f ${markerQ} ]; then
  "$VENV/bin/python" -m pip install ${packageInstall}
  touch ${markerQ}
fi
printf '%s' weights > ${stageFileQ}
if [ -r ${modelFileQ} ] && [ "$(cat ${modelFileQ})" = ${modelQ} ] && [ -r ${pidFileQ} ] && kill -0 "$(cat ${pidFileQ})" 2>/dev/null; then
  :
else
  ${stopPidScript(paths.pid)}
  printf '%s' ${modelQ} > ${modelFileQ}
  nohup setsid ${install} ${launchArgs} > ${logFileQ} 2>&1 < /dev/null 9>&- &
  echo $! > ${pidFileQ}
  STARTED_SERVER=1
fi
${waitReadyScript(runtime, paths)}
printf '%s' ready > ${stageFileQ}
STARTED_SERVER=0`;
}

export function buildManagedSttStopCommand({ backend, root = STT_RUNTIME_ROOT }) {
  const runtime = managedSttRuntime(backend);
  if (!runtime) throw new Error(`Unsupported managed STT backend: ${backend}`);
  if (runtime.mode === "executable") return "set -eu\n:";
  const paths = managedSttRuntimePaths(backend, root);
  return `set -eu
${stopPidScript(paths.pid)}`;
}
