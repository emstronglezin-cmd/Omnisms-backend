FROM python:3.11-slim

WORKDIR /app

# Dépendances système pour faster-whisper
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# Créer le dossier modèles
RUN mkdir -p /app/models

ENV WHISPER_MODEL=small
ENV WHISPER_DEVICE=cpu
ENV WHISPER_LANGUAGE=fr
ENV PORT=9000
ENV HOST=0.0.0.0

EXPOSE 9000

CMD ["gunicorn", "--bind", "0.0.0.0:9000", "--workers", "1", "--timeout", "300", "--preload", "app:app"]
