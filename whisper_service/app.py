#!/usr/bin/env python3
"""
OmniSMS — Service Faster-Whisper (HTTP)

Service Python léger exposant une API HTTP pour la transcription audio
avec faster-whisper (open source, sans API OpenAI).

Port : 9000 (configurable via PORT env var)
CPU only par défaut — compatible Render/Docker gratuit.

Endpoints :
  GET  /health         → { status: "ok", model: "small" }
  POST /transcribe     → { text, language, duration, segments }

Installation :
  pip install faster-whisper flask

Lancement :
  python app.py
  ou
  WHISPER_MODEL=small PORT=9000 python app.py
"""

import os
import sys
import json
import logging
import threading
from pathlib import Path

# Flask — requis
try:
    from flask import Flask, request, jsonify
except ImportError:
    print("ERROR: Flask not installed. Run: pip install flask", file=sys.stderr)
    sys.exit(1)

# Faster-Whisper — requis
try:
    from faster_whisper import WhisperModel
    WHISPER_AVAILABLE = True
except ImportError:
    WHISPER_AVAILABLE = False
    print("WARNING: faster-whisper not installed. Run: pip install faster-whisper", file=sys.stderr)

# ── Configuration ──────────────────────────────────────────────
MODEL_NAME = os.environ.get("WHISPER_MODEL",    "small")
LANGUAGE   = os.environ.get("WHISPER_LANGUAGE", "fr")
DEVICE     = os.environ.get("WHISPER_DEVICE",   "cpu")
PORT       = int(os.environ.get("PORT",          9000))
HOST       = os.environ.get("HOST",              "0.0.0.0")

# Compute type adapté CPU
COMPUTE_TYPE = "int8" if DEVICE == "cpu" else "float16"

logging.basicConfig(
    level  = logging.INFO,
    format = "%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("whisper-service")

# ── Chargement du modèle (lazy, thread-safe) ───────────────────
_model     = None
_model_lock = threading.Lock()

def get_model():
    """Charge le modèle Faster-Whisper une seule fois (singleton thread-safe)."""
    global _model
    if _model is not None:
        return _model
    with _model_lock:
        if _model is None:
            log.info(f"Loading Faster-Whisper model: {MODEL_NAME} ({DEVICE}, {COMPUTE_TYPE})…")
            try:
                _model = WhisperModel(
                    MODEL_NAME,
                    device       = DEVICE,
                    compute_type = COMPUTE_TYPE,
                    download_root= os.path.join(os.path.dirname(__file__), "models"),
                )
                log.info(f"Model '{MODEL_NAME}' loaded successfully.")
            except Exception as e:
                log.error(f"Failed to load model '{MODEL_NAME}': {e}")
                raise
    return _model

# ── Flask app ──────────────────────────────────────────────────
app = Flask(__name__)

@app.route("/health", methods=["GET"])
def health():
    """Health check — retourne 200 si le service est prêt."""
    return jsonify({
        "status"       : "ok",
        "model"        : MODEL_NAME,
        "device"       : DEVICE,
        "compute_type" : COMPUTE_TYPE,
        "language"     : LANGUAGE,
        "whisper_ready": WHISPER_AVAILABLE,
    })


@app.route("/transcribe", methods=["POST"])
def transcribe():
    """
    Transcrire un fichier audio.

    Body JSON :
      {
        "audio_path" : "/path/to/audio.m4a",   ← chemin absolu sur le serveur
        "language"   : "fr",                    ← optionnel
        "model"      : "small"                  ← optionnel
      }

    Réponse :
      {
        "text"     : "Bonjour comment vas-tu ?",
        "language" : "fr",
        "duration" : 4.5,
        "segments" : [ { "start": 0, "end": 2.3, "text": "Bonjour" }, ... ]
      }
    """
    if not WHISPER_AVAILABLE:
        return jsonify({
            "error": "faster-whisper non installé. Run: pip install faster-whisper"
        }), 503

    data = request.get_json(silent=True) or {}
    audio_path = data.get("audio_path", "")
    language   = data.get("language", LANGUAGE) or LANGUAGE

    if not audio_path:
        return jsonify({"error": "audio_path requis"}), 400

    if not Path(audio_path).exists():
        return jsonify({"error": f"Fichier introuvable: {audio_path}"}), 404

    try:
        model = get_model()
        log.info(f"Transcribing: {audio_path} (lang={language})")

        segments_gen, info = model.transcribe(
            audio_path,
            language           = language if language != "auto" else None,
            beam_size          = 5,
            vad_filter         = True,
            vad_parameters     = {"min_silence_duration_ms": 500},
            word_timestamps    = False,
        )

        # Matérialiser les segments (générateur → liste)
        segments = []
        full_text_parts = []
        for seg in segments_gen:
            segments.append({
                "start": round(seg.start, 2),
                "end"  : round(seg.end,   2),
                "text" : seg.text.strip(),
            })
            full_text_parts.append(seg.text.strip())

        full_text = " ".join(full_text_parts)
        duration  = round(info.duration, 2)

        log.info(f"Transcription done: {len(full_text)} chars, {len(segments)} segments, {duration}s")

        return jsonify({
            "text"           : full_text,
            "language"       : info.language,
            "language_prob"  : round(info.language_probability, 3),
            "duration"       : duration,
            "segments"       : segments,
            "model"          : MODEL_NAME,
        })

    except Exception as e:
        log.error(f"Transcription error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/models", methods=["GET"])
def list_models():
    """Liste les modèles disponibles."""
    return jsonify({
        "available_models": ["tiny", "base", "small", "medium", "large-v2", "large-v3"],
        "current_model"   : MODEL_NAME,
        "note"            : "Changez WHISPER_MODEL dans les env vars Render pour changer de modèle.",
    })


# ── Point d'entrée ─────────────────────────────────────────────
if __name__ == "__main__":
    log.info(f"Starting Faster-Whisper service on {HOST}:{PORT}…")
    log.info(f"Model: {MODEL_NAME} | Device: {DEVICE} | Compute: {COMPUTE_TYPE}")

    # Pré-charger le modèle au démarrage (évite le cold start sur la première requête)
    if WHISPER_AVAILABLE:
        try:
            get_model()
        except Exception as e:
            log.warning(f"Modèle non pré-chargé: {e}. Chargement différé.")

    app.run(host=HOST, port=PORT, debug=False, threaded=True)
