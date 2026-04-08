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

# Copy root .env for dotenv loading (will be overridden by Render env vars)
COPY .env* ./

# Voice server uses $PORT from Render
CMD ["sh", "-c", "python -m voice.server serve --port ${PORT:-8000}"]
