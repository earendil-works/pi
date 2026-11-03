"""Text-to-speech engines of the p2 speech service. Each engine yields float32 mono chunks while it generates.

- supertonic: Supertonic 3 (ONNX). Renders whole sentences; one chunk per sentence.
- pocket: Kyutai Pocket TTS (PyTorch, CPU). Streams ~80 ms chunks while it generates.
- kokoro: Kokoro 82M v1.0 (ONNX). One chunk per sentence.

Every engine has one model instance; a lock serializes requests to it. `stop` cancels between chunks.
"""

import os
import re
import threading
from collections.abc import Iterator

import numpy as np

MODELS = os.environ.get("VOICE_MODELS", "/models")
SENTENCE_GAP_S = 0.25


def ort_session(path: str):
    """ONNX Runtime session with a capped thread pool and no spin-waiting, so an idle service uses no CPU."""
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = int(os.environ.get("VOICE_TTS_THREADS", "8"))
    options.inter_op_num_threads = 1
    options.add_session_config_entry("session.intra_op.allow_spinning", "0")
    options.add_session_config_entry("session.inter_op.allow_spinning", "0")
    return ort.InferenceSession(path, sess_options=options, providers=["CPUExecutionProvider"])


def sentences(text: str) -> list[str]:
    """Splits text at sentence ends and paragraphs, keeping common abbreviations together."""
    from supertonic_helper import chunk_text

    return [part for part in chunk_text(text, max_len=0) if part.strip()]


class Engine:
    id = ""
    name = ""
    streaming = False
    sample_rate = 24000
    default_speed = 1.0
    voices: dict[str, str] = {}  # voice name -> display name
    default_voice = ""

    def __init__(self) -> None:
        self.lock = threading.Lock()

    def generate(self, text: str, voice: str, speed: float, stop: threading.Event) -> Iterator[np.ndarray]:
        raise NotImplementedError

    def stream(self, text: str, voice: str, speed: float | None, stop: threading.Event) -> Iterator[np.ndarray]:
        with self.lock:
            for chunk in self.generate(text, voice, self.default_speed if speed is None else speed, stop):
                if stop.is_set():
                    return
                if len(chunk):
                    yield chunk


class SentenceEngine(Engine):
    """Engines that render a sentence at a time. Sentences after the first get a short leading pause."""

    def sentence(self, text: str, voice: str, speed: float) -> np.ndarray:
        raise NotImplementedError

    def generate(self, text: str, voice: str, speed: float, stop: threading.Event) -> Iterator[np.ndarray]:
        gap = np.zeros(int(self.sample_rate * SENTENCE_GAP_S), dtype=np.float32)
        for index, part in enumerate(sentences(text)):
            if stop.is_set():
                return
            audio = self.sentence(part, voice, speed).astype(np.float32, copy=False)
            yield np.concatenate([gap, audio]) if index else audio


class Supertonic(SentenceEngine):
    id = "supertonic"
    name = "Supertonic 3"
    default_speed = 1.05

    def __init__(self) -> None:
        super().__init__()
        from supertonic_helper import TextToSpeech, load_cfgs, load_text_processor, load_voice_style

        base = f"{MODELS}/supertonic3"
        onnx = f"{base}/onnx"
        sessions = [ort_session(f"{onnx}/{name}.onnx")
                    for name in ("duration_predictor", "text_encoder", "vector_estimator", "vocoder")]
        self.tts = TextToSpeech(load_cfgs(onnx), load_text_processor(onnx), *sessions)
        self.sample_rate = self.tts.sample_rate
        self.steps = int(os.environ.get("VOICE_TTS_STEPS", "5"))
        names = sorted(name[: -len(".json")] for name in os.listdir(f"{base}/voice_styles") if name.endswith(".json"))
        self.styles = {name: load_voice_style([f"{base}/voice_styles/{name}.json"]) for name in names}
        self.voices = {name: f"{'Female' if name[0] == 'F' else 'Male'} {name[1:]}" for name in names}
        self.default_voice = "F1"

    def sentence(self, text: str, voice: str, speed: float) -> np.ndarray:
        wav, duration = self.tts._infer([text], ["en"], self.styles[voice], self.steps, speed)
        return wav[0, : int(self.sample_rate * duration[0].item())]


KOKORO_VOICES = {
    "af_heart": "Heart (US female)",
    "af_bella": "Bella (US female)",
    "af_nicole": "Nicole (US female)",
    "af_sarah": "Sarah (US female)",
    "am_michael": "Michael (US male)",
    "am_adam": "Adam (US male)",
    "am_fenrir": "Fenrir (US male)",
    "bf_emma": "Emma (UK female)",
    "bf_isabella": "Isabella (UK female)",
    "bm_george": "George (UK male)",
    "bm_lewis": "Lewis (UK male)",
    "bm_fable": "Fable (UK male)",
}


class Kokoro(SentenceEngine):
    id = "kokoro"
    name = "Kokoro"

    def __init__(self) -> None:
        super().__init__()
        from kokoro_onnx import Kokoro as KokoroModel

        self.model = KokoroModel.from_session(ort_session(f"{MODELS}/kokoro/kokoro-v1.0.onnx"),
                                              f"{MODELS}/kokoro/voices-v1.0.bin")
        available = set(self.model.get_voices())
        self.voices = {name: label for name, label in KOKORO_VOICES.items() if name in available}
        self.default_voice = "af_heart"

    def sentence(self, text: str, voice: str, speed: float) -> np.ndarray:
        audio, _ = self.model.create(text, voice=voice, speed=speed, lang="en-gb" if voice[0] == "b" else "en-us")
        return audio


# Pocket TTS's English catalog (https://huggingface.co/kyutai/tts-voices); states are exported at image build.
POCKET_VOICES = ("alba", "anna", "azelma", "bill_boerst", "caro_davy", "charles", "cosette", "eponine", "eve",
                 "fantine", "george", "jane", "jean", "javert", "marius", "mary", "michael", "paul", "peter_yearsley",
                 "stuart_bell", "vera")


class Pocket(Engine):
    id = "pocket"
    name = "Pocket TTS (Kyutai)"
    streaming = True

    def __init__(self) -> None:
        super().__init__()
        import torch
        from pocket_tts import TTSModel

        self.model = TTSModel.load_model()
        torch.set_num_threads(int(os.environ.get("VOICE_POCKET_THREADS", "2")))  # pocket_tts sets 1 on import
        self.sample_rate = self.model.sample_rate
        self.states = {name: self.model.get_state_for_audio_prompt(f"{MODELS}/pocket/{name}.safetensors")
                       for name in POCKET_VOICES if os.path.exists(f"{MODELS}/pocket/{name}.safetensors")}
        self.voices = {name: name.replace("_", " ").title() for name in self.states}
        self.default_voice = "alba"

    def generate(self, text: str, voice: str, speed: float, stop: threading.Event) -> Iterator[np.ndarray]:
        for chunk in self.model.generate_audio_stream(self.states[voice], text, stop=stop):
            yield chunk.numpy().reshape(-1)


ENGINE_CLASSES = {cls.id: cls for cls in (Supertonic, Pocket, Kokoro)}
VOICE_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


def load_engines() -> dict[str, Engine]:
    names = [name.strip() for name in os.environ.get("VOICE_ENGINES", "supertonic,pocket,kokoro").split(",")]
    return {name: ENGINE_CLASSES[name]() for name in names if name in ENGINE_CLASSES}
