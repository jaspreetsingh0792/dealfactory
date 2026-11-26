#!/usr/bin/env bash
set -euo pipefail
release_dir=$1
model_dir="$RUNNER_TEMP/dealfactory-model"
mkdir -p "$model_dir"
model=qwen2.5-0.5b-instruct-q4_k_m.gguf
checksum=74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db
if [[ ! -s "$model_dir/$model" ]]; then
  curl -fsSL --retry 2 --max-time 180 \
    "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/$model" -o "$model_dir/$model"
fi
printf '%s  %s\n' "$checksum" "$model_dir/$model" | sha256sum --check --status
docker run -d --rm --name dealfactory-editor --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:18082:8080 -v "$model_dir:/models:ro" ghcr.io/ggml-org/llama.cpp:server \
  -m "/models/$model" -c 1024 -t 2 --host 0.0.0.0 --port 8080 >/dev/null
trap 'docker stop dealfactory-editor >/dev/null || true' EXIT
curl -fsS --retry 30 --retry-all-errors --retry-delay 2 --max-time 4 http://127.0.0.1:18082/health -o /dev/null
python3 ops/editor.py "$release_dir" | tee -a "$GITHUB_STEP_SUMMARY"
