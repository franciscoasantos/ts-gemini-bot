FROM node:20-bookworm-slim

# sherpa-onnx-node and opusscript are prebuilt binaries/WASM — no toolchain.
# Only the speech models need downloading and unpacking.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates wget bzip2 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

# Multilingual Whisper (base) to transcribe PT + silero VAD
RUN MODEL=sherpa-onnx-whisper-base \
 && wget -q "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL}.tar.bz2" \
 && tar xjf "${MODEL}.tar.bz2" \
 && mv "${MODEL}" model \
 && rm "${MODEL}.tar.bz2" \
 && wget -q "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx" -O model/silero_vad.onnx

COPY tsconfig.json avatar.png ./
COPY src ./src

# node as PID 1 (gets SIGTERM directly → disconnects cleanly, no ghost clone)
CMD ["node", "--import", "tsx", "src/index.ts"]
