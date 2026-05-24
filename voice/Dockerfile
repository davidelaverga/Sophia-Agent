# Sophia Voice Server — Vision Agents + Deepgram STT + Cartesia TTS
FROM python:3.12-slim

# System deps for audio processing
RUN apt-get update && apt-get install -y \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

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

# Voice server uses $PORT from Render
CMD ["sh", "-c", "python -m voice.server serve --host 0.0.0.0 --port ${PORT:-8000}"]
