# p2 speech service (server.py). Models are downloaded at build time into /models; the service runs offline.
FROM python:3.12-slim

RUN pip install --no-cache-dir sherpa-onnx==1.13.8 onnxruntime==1.31.0 numpy==2.5.4 aiohttp==3.14.5 \
	kokoro-onnx==0.6.1 soundfile==0.13.1
RUN pip install --no-cache-dir torch==2.14.1 pocket-tts==3.3.0 --extra-index-url https://download.pytorch.org/whl/cpu

# Speech to text: Silero VAD + Parakeet TDT 0.6B v3 (int8).
ADD https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx /models/silero_vad.onnx
ADD https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2 /tmp/parakeet.tar.bz2
RUN python -c "import tarfile; tarfile.open('/tmp/parakeet.tar.bz2').extractall('/tmp')" \
	&& mkdir -p /models/parakeet \
	&& mv /tmp/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/*.onnx /tmp/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/tokens.txt /models/parakeet/ \
	&& rm -rf /tmp/parakeet.tar.bz2 /tmp/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8

# Supertonic 3.
RUN python - <<'PY'
import os, urllib.request
base = "https://huggingface.co/Supertone/supertonic-3/resolve/main/"
files = [f"onnx/{name}" for name in ("duration_predictor.onnx", "text_encoder.onnx", "tts.json", "unicode_indexer.json", "vector_estimator.onnx", "vocoder.onnx")]
files += [f"voice_styles/{kind}{n}.json" for kind in "FM" for n in range(1, 6)]
for file in files:
    path = f"/models/supertonic3/{file}"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    urllib.request.urlretrieve(base + file, path)
PY

# Kokoro 82M v1.0.
ADD https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx /models/kokoro/kokoro-v1.0.onnx
ADD https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin /models/kokoro/voices-v1.0.bin

WORKDIR /app
COPY engines.py supertonic_helper.py ./

# Pocket TTS: weights into the Hugging Face cache, voice prompts exported as ready KV-cache states.
ENV HF_HOME=/models/hf
RUN python - <<'PY'
import os
from pocket_tts import TTSModel, export_model_state
from engines import POCKET_VOICES
model = TTSModel.load_model()
os.makedirs("/models/pocket", exist_ok=True)
for name in POCKET_VOICES:
    export_model_state(model.get_state_for_audio_prompt(name), f"/models/pocket/{name}.safetensors")
PY

COPY segmenter.py server.py test_segmenter.py ./
ENV PYTHONUNBUFFERED=1 HF_HUB_OFFLINE=1
EXPOSE 8000
CMD ["python", "server.py"]
