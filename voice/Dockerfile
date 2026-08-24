# Sophia Voice Server — Vision Agents + Deepgram STT + Cartesia TTS
FROM python:3.12-slim

# System deps for audio processing
RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ONNX Runtime 1.29 enables POSIX telemetry during native initialization. Keep
# its uploader disabled before smart-turn imports ONNX so shutdown cannot race
# destruction of the telemetry client's native mutex.
ENV ORT_DISABLE_TELEMETRY=1

# Install Python deps
COPY voice/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy voice service code
COPY voice/ ./voice/

# Copy realtime prompt sources used by voice/realtime/sophia_prompt.py
COPY skills/public/sophia/ ./skills/public/sophia/
COPY backend/packages/harness/deerflow/agents/sophia_agent/middlewares/platform_context.py \
    ./backend/packages/harness/deerflow/agents/sophia_agent/middlewares/platform_context.py
COPY backend/packages/harness/deerflow/agents/sophia_agent/middlewares/artifact.py \
    ./backend/packages/harness/deerflow/agents/sophia_agent/middlewares/artifact.py

# Copy dependency-safe backend contracts used by Gemini Live tool declarations.
COPY backend/packages/harness/deerflow/__init__.py \
    ./backend/packages/harness/deerflow/__init__.py
COPY backend/packages/harness/deerflow/sophia/__init__.py \
    ./backend/packages/harness/deerflow/sophia/__init__.py
COPY backend/packages/harness/deerflow/sophia/tools/__init__.py \
    ./backend/packages/harness/deerflow/sophia/tools/__init__.py
COPY backend/packages/harness/deerflow/sophia/tools/emit_artifact_contract.py \
    ./backend/packages/harness/deerflow/sophia/tools/emit_artifact_contract.py
COPY backend/packages/harness/deerflow/sophia/tools/builder_lifecycle_contract.py \
    ./backend/packages/harness/deerflow/sophia/tools/builder_lifecycle_contract.py
COPY backend/packages/harness/deerflow/sophia/tools/retrieve_memories_contract.py \
    ./backend/packages/harness/deerflow/sophia/tools/retrieve_memories_contract.py
ENV PYTHONPATH="/app/backend/packages/harness:${PYTHONPATH}"

# Voice server uses $PORT from Render
CMD ["sh", "-c", "python -m voice.server serve --host 0.0.0.0 --port ${PORT:-8000}"]
