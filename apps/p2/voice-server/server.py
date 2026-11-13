"""p2 speech service: speech to text (Silero VAD + Parakeet TDT 0.6B v3) and text to speech, on CPU.

Every request needs `Authorization: Bearer $VOICE_TOKEN`. p2's voice plugin is the only client: browsers reach this
service through p2, which signs them in.

GET  /health   -> {"ok": true}  (no auth)
GET  /voices   -> {"engines": [{"id", "name", "streaming", "sampleRate", "voices": [{"id", "name"}]}],
                   "default": {"engine", "voice"}}
                  Voice ids are "<engine>-<voice>" (for example "supertonic-F1", "pocket-alba", "kokoro-af_heart")
                  and match [A-Za-z0-9_-]{1,32}; each engine lists its default voice first. "streaming" is true for
                  engines that stream while they generate; the others deliver one chunk per sentence.
POST /speak    {"text", "engine"?, "voice"?, "speed"?} -> audio/wav (16-bit mono) of the whole text
                  voice: a voice id from /voices (it names the engine; engine, if given, must match). Without voice:
                  the engine's default voice; without either: the service default. speed: 0.5-2.0 (default 1.05 for
                  Supertonic, 1.0 for Kokoro), ignored by Pocket TTS.
WS   /speak/stream  (primary text-to-speech interface)
                  client -> server (text): {"type": "speak", "id", "text", "engine"?, "voice"?, "speed"?}
                                           {"type": "cancel", "id"?}   (no id: cancel everything)
                  server -> client (text): {"type": "ready"}
                                           {"type": "start", "id", "engine", "voice", "sampleRate"}
                                           {"type": "done", "id", "cancelled", "firstChunkMs", "ms", "audioMs"}
                                           {"type": "error", "id"?, "error"}
                  server -> client (binary): one audio chunk = 1 byte n (id length), n bytes id (ASCII), then
                                           16-bit little-endian mono PCM at the request's sampleRate. The PCM may
                                           start at an odd offset: copy it before viewing it as Int16Array.
                  id: [A-Za-z0-9_-]{1,64}, chosen by the client, unique among its pending requests. engine, voice
                  and speed as for POST /speak. Requests run in order, one at a time per socket, each as fast as
                  the engine generates: start, its chunks, then done, or error instead of done if synthesis fails.
                  A cancelled request (queued or running) gets done with cancelled: true and no further chunks.
                  Streaming engines send ~80 ms chunks while generating; the others one chunk per sentence.
WS   /listen   binary frames: 16 kHz mono PCM16LE microphone audio; text frames: {"type": "reset"}
                  replies: {"type": "ready"}, {"type": "speech_start"}, {"type": "speech_end"},
                  {"type": "final", "text", "ms"}
"""

import asyncio
import hmac
import io
import json
import os
import re
import threading
import time
import wave
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import numpy as np
import sherpa_onnx
from aiohttp import WSMsgType, web

from engines import VOICE_PATTERN, Engine, load_engines
from segmenter import Segmenter

MODELS = os.environ.get("VOICE_MODELS", "/models")
TOKEN = os.environ["VOICE_TOKEN"]
SAMPLE_RATE = 16000
MAX_TEXT = 2000
ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

parakeet = f"{MODELS}/parakeet"
recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
    encoder=f"{parakeet}/encoder.int8.onnx",
    decoder=f"{parakeet}/decoder.int8.onnx",
    joiner=f"{parakeet}/joiner.int8.onnx",
    tokens=f"{parakeet}/tokens.txt",
    num_threads=4,
    model_type="nemo_transducer",
)
engines: dict[str, Engine] = load_engines()
DEFAULT_ENGINE = os.environ.get("VOICE_DEFAULT_ENGINE", "supertonic")
if DEFAULT_ENGINE not in engines:
    DEFAULT_ENGINE = next(iter(engines))
DEFAULT_VOICE = os.environ.get("VOICE_DEFAULT", engines[DEFAULT_ENGINE].default_voice)
if DEFAULT_VOICE not in engines[DEFAULT_ENGINE].voices:
    DEFAULT_VOICE = engines[DEFAULT_ENGINE].default_voice
# Blocking work runs off the event loop: decoding in its own pool, so speech never waits behind synthesis.
stt_pool = ThreadPoolExecutor(max_workers=2)
tts_pool = ThreadPoolExecutor(max_workers=4)


def vad_config() -> sherpa_onnx.VadModelConfig:
    config = sherpa_onnx.VadModelConfig()
    config.silero_vad.model = f"{MODELS}/silero_vad.onnx"
    config.silero_vad.threshold = float(os.environ.get("VOICE_VAD_THRESHOLD", "0.5"))
    config.silero_vad.min_silence_duration = float(os.environ.get("VOICE_VAD_SILENCE", "1.2"))
    config.silero_vad.min_speech_duration = 0.25
    config.silero_vad.max_speech_duration = 30
    config.silero_vad.window_size = 512
    config.sample_rate = SAMPLE_RATE
    config.num_threads = 1
    return config


VAD_PREROLL_MS = float(os.environ.get("VOICE_VAD_PREROLL_MS", "750"))


class BadRequest(Exception):
    pass


def authorized(request: web.Request) -> bool:
    header = request.headers.get("Authorization", "")
    return hmac.compare_digest(header.encode(), f"Bearer {TOKEN}".encode())


def resolve(engine_id: object, voice: object) -> tuple[Engine, str]:
    """Maps {engine?, voice?} to an engine and one of its voice names. voice is a voice id from /voices."""
    engine_id = str(engine_id) if engine_id else None
    if voice:
        voice = str(voice)
        prefix, _, name = voice.partition("-")
        if not VOICE_PATTERN.match(voice) or prefix not in engines or name not in engines[prefix].voices:
            raise BadRequest(f"unknown voice {voice}")
        if engine_id and engine_id != prefix:
            raise BadRequest("voice does not belong to engine")
        return engines[prefix], name
    engine = engines.get(engine_id or DEFAULT_ENGINE)
    if engine is None:
        raise BadRequest(f"unknown engine {engine_id}")
    return engine, (DEFAULT_VOICE if engine.id == DEFAULT_ENGINE else engine.default_voice)


def parse_request(body: object) -> tuple[Engine, str, str, float | None]:
    if not isinstance(body, dict) or not isinstance(body.get("text"), str):
        raise BadRequest("expected {text, voice?, engine?, speed?}")
    text = body["text"].strip()
    if not text or len(text) > MAX_TEXT:
        raise BadRequest("invalid text")
    engine, voice = resolve(body.get("engine"), body.get("voice"))
    speed = body.get("speed")
    if speed is not None:
        try:
            speed = float(speed)
        except (TypeError, ValueError):
            raise BadRequest("invalid speed") from None
        if not 0.5 <= speed <= 2.0:
            raise BadRequest("invalid speed")
    return engine, voice, text, speed


def pcm16(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()


def transcribe(samples: np.ndarray) -> str:
    stream = recognizer.create_stream()
    stream.accept_waveform(SAMPLE_RATE, samples)
    recognizer.decode_stream(stream)
    return stream.result.text.strip()


@web.middleware
async def auth(request: web.Request, handler):
    if request.path != "/health" and not authorized(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    return await handler(request)


async def health(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def voices(_request: web.Request) -> web.Response:
    listed = []
    for engine in engines.values():
        default = DEFAULT_VOICE if engine.id == DEFAULT_ENGINE else engine.default_voice
        names = [default] + [name for name in engine.voices if name != default]  # the engine's default first
        listed.append({
            "id": engine.id,
            "name": engine.name,
            "streaming": engine.streaming,
            "sampleRate": engine.sample_rate,
            "voices": [{"id": f"{engine.id}-{name}", "name": engine.voices[name]} for name in names],
        })
    return web.json_response(
        {"engines": listed, "default": {"engine": DEFAULT_ENGINE, "voice": f"{DEFAULT_ENGINE}-{DEFAULT_VOICE}"}}
    )


async def speak(request: web.Request) -> web.Response:
    try:
        engine, voice, text, speed = parse_request(await request.json())
    except (BadRequest, ValueError) as error:
        return web.json_response({"error": str(error) or "invalid request"}, status=400)
    started = time.monotonic()

    def render() -> bytes:
        return b"".join(pcm16(chunk) for chunk in engine.stream(text, voice, speed, threading.Event()))

    pcm = await asyncio.get_running_loop().run_in_executor(tts_pool, render)
    out = io.BytesIO()
    with wave.open(out, "wb") as file:
        file.setnchannels(1)
        file.setsampwidth(2)
        file.setframerate(engine.sample_rate)
        file.writeframes(pcm)
    return web.Response(
        body=out.getvalue(),
        content_type="audio/wav",
        headers={
            "X-Synthesis-Ms": str(round((time.monotonic() - started) * 1000)),
            "X-Voice": f"{engine.id}-{voice}",
        },
    )


@dataclass
class SpeakJob:
    id: str
    engine: Engine
    voice: str
    text: str
    speed: float | None
    stop: threading.Event = field(default_factory=threading.Event)


async def speak_stream(request: web.Request) -> web.WebSocketResponse:
    socket = web.WebSocketResponse(heartbeat=20, max_msg_size=64 * 1024)
    await socket.prepare(request)
    loop = asyncio.get_running_loop()
    jobs: asyncio.Queue[SpeakJob] = asyncio.Queue()
    queued: dict[str, SpeakJob] = {}  # waiting and running jobs by id
    current: SpeakJob | None = None

    async def send_json(message: dict) -> None:
        if not socket.closed:
            await socket.send_json(message)

    async def run(job: SpeakJob) -> None:
        chunks: asyncio.Queue = asyncio.Queue()
        done = object()

        def produce() -> None:
            try:
                for chunk in job.engine.stream(job.text, job.voice, job.speed, job.stop):
                    loop.call_soon_threadsafe(chunks.put_nowait, chunk)
            except Exception as error:  # reported to the client below
                loop.call_soon_threadsafe(chunks.put_nowait, error)
            loop.call_soon_threadsafe(chunks.put_nowait, done)

        started = time.monotonic()
        first_ms = None
        samples = 0
        header = bytes([len(job.id)]) + job.id.encode()
        await send_json({"type": "start", "id": job.id, "engine": job.engine.id,
                         "voice": f"{job.engine.id}-{job.voice}", "sampleRate": job.engine.sample_rate})
        loop.run_in_executor(tts_pool, produce)
        failure = None
        while (item := await chunks.get()) is not done:
            if isinstance(item, Exception):
                failure = str(item) or type(item).__name__
                continue
            if job.stop.is_set() or socket.closed:
                continue
            if first_ms is None:
                first_ms = round((time.monotonic() - started) * 1000)
            samples += len(item)
            await socket.send_bytes(header + pcm16(item))
        if failure is not None:
            await send_json({"type": "error", "id": job.id, "error": failure})
            return
        await send_json({"type": "done", "id": job.id, "cancelled": job.stop.is_set(), "firstChunkMs": first_ms,
                         "ms": round((time.monotonic() - started) * 1000),
                         "audioMs": round(samples * 1000 / job.engine.sample_rate)})

    async def worker() -> None:
        nonlocal current
        while True:
            job = await jobs.get()
            if job.stop.is_set():
                await send_json({"type": "done", "id": job.id, "cancelled": True, "firstChunkMs": None,
                                 "ms": 0, "audioMs": 0})
            else:
                current = job
                await run(job)
                current = None
            if queued.get(job.id) is job:
                del queued[job.id]

    runner = asyncio.ensure_future(worker())
    await send_json({"type": "ready"})
    try:
        async for message in socket:
            if message.type != WSMsgType.TEXT:
                if message.type == WSMsgType.BINARY:
                    await send_json({"type": "error", "error": "expected text frames"})
                    continue
                break
            try:
                body = json.loads(message.data)
            except ValueError:
                await send_json({"type": "error", "error": "invalid JSON"})
                continue
            kind = body.get("type") if isinstance(body, dict) else None
            if kind == "cancel":
                target = body.get("id")
                for job in list(queued.values()):
                    if target is None or job.id == target:
                        job.stop.set()
                continue
            if kind != "speak":
                await send_json({"type": "error", "error": "expected type speak or cancel"})
                continue
            job_id = body.get("id")
            if not isinstance(job_id, str) or not ID_PATTERN.match(job_id):
                await send_json({"type": "error", "error": "invalid id"})
                continue
            if job_id in queued:
                await send_json({"type": "error", "id": job_id, "error": "duplicate id"})
                continue
            try:
                engine, voice, text, speed = parse_request(body)
            except BadRequest as error:
                await send_json({"type": "error", "id": job_id, "error": str(error)})
                continue
            job = SpeakJob(job_id, engine, voice, text, speed)
            queued[job_id] = job
            jobs.put_nowait(job)
    finally:
        for job in queued.values():
            job.stop.set()
        runner.cancel()
    return socket


async def listen(request: web.Request) -> web.WebSocketResponse:
    socket = web.WebSocketResponse(heartbeat=20, max_msg_size=1 << 20)
    await socket.prepare(request)
    segmenter = Segmenter(vad_config(), VAD_PREROLL_MS)
    loop = asyncio.get_running_loop()
    # Finals go out in utterance order even when a later one decodes faster.
    decoding: asyncio.Future | None = None

    async def decode(samples: np.ndarray, previous: asyncio.Future | None) -> None:
        started = time.monotonic()
        text = await loop.run_in_executor(stt_pool, transcribe, samples)
        if previous is not None:
            await previous
        if not socket.closed:
            ms = round((time.monotonic() - started) * 1000)
            await socket.send_json({"type": "final", "text": text, "ms": ms})

    await socket.send_json({"type": "ready", "sampleRate": SAMPLE_RATE})
    async for message in socket:
        if message.type == WSMsgType.TEXT:
            if json.loads(message.data).get("type") == "reset":
                speaking = segmenter.speaking
                segmenter.reset()
                if speaking:
                    await socket.send_json({"type": "speech_end"})
            continue
        if message.type != WSMsgType.BINARY:
            break
        samples = np.frombuffer(message.data, dtype="<i2").astype(np.float32) / 32768.0
        for event, utterance in segmenter.accept(samples):
            await socket.send_json({"type": event})
            if utterance is not None:
                decoding = asyncio.ensure_future(decode(utterance, decoding))
    return socket


app = web.Application(middlewares=[auth], client_max_size=64 * 1024)
app.add_routes(
    [
        web.get("/health", health),
        web.get("/voices", voices),
        web.post("/speak", speak),
        web.get("/speak/stream", speak_stream),
        web.get("/listen", listen),
    ]
)

if __name__ == "__main__":
    web.run_app(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8000")))
