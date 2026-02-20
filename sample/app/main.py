"""
Voice Chatbot Backend - FastAPI + Google ADK runner.run_live()
Uses ADK's built-in VAD — no manual end_of_turn signaling needed.
Run with: uvicorn app.main:app --reload
"""

import asyncio
import base64
import json
import os
import uuid
import warnings
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(override=True)

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from google.adk.agents import Agent
from google.adk.agents.live_request_queue import LiveRequestQueue
from google.adk.agents.run_config import RunConfig, StreamingMode
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types as genai_types

# Suppress noisy pydantic serialization warnings from ADK internals
warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

# ── App setup ─────────────────────────────────────────────────────────────────
APP_NAME   = "voice-chatbot"
PROJECT    = os.getenv("GOOGLE_CLOUD_PROJECT", "")
LOCATION   = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")
MODEL      = os.getenv("AGENT_MODEL", "gemini-live-2.5-flash-native-audio")
USE_VERTEX = os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "FALSE").upper() == "TRUE"

# Set Vertex env var so ADK picks it up automatically
if USE_VERTEX:
    os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "TRUE"
    os.environ["GOOGLE_CLOUD_PROJECT"]      = PROJECT
    os.environ["GOOGLE_CLOUD_LOCATION"]     = LOCATION

print(f"[INIT] Model: {MODEL} | Vertex: {USE_VERTEX} | Project: {PROJECT}")

# ── ADK agent + runner (created once at startup) ───────────────────────────────
SYSTEM_INSTRUCTION = (
    "You are a friendly voice assistant. "
    "Answer questions clearly and concisely. "
    "Always respond in English only, regardless of what language the user speaks. "
    "Keep responses short and conversational."
)

voice_agent = Agent(
    name="voice_qa_agent",
    model=MODEL,
    instruction=SYSTEM_INSTRUCTION,
)

session_service = InMemorySessionService()
runner = Runner(app_name=APP_NAME, agent=voice_agent, session_service=session_service)

# ── FastAPI app ────────────────────────────────────────────────────────────────
app = FastAPI(title="Voice Chatbot")

static_path = Path(__file__).parent / "static"
static_path.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_path)), name="static")

# ── RunConfig for native audio model ──────────────────────────────────────────
# Native audio models ONLY support AUDIO response modality.
# ADK's built-in VAD handles when to respond — no manual turn signaling needed.
RUN_CONFIG = RunConfig(
    streaming_mode=StreamingMode.BIDI,
    response_modalities=["AUDIO"],
    input_audio_transcription=genai_types.AudioTranscriptionConfig(),
    output_audio_transcription=genai_types.AudioTranscriptionConfig(),
    speech_config=genai_types.SpeechConfig(
        language_code="en-US",
        voice_config=genai_types.VoiceConfig(
            prebuilt_voice_config=genai_types.PrebuiltVoiceConfig(voice_name="Aoede")
        ),
    ),
)


# ── WebSocket endpoint ────────────────────────────────────────────────────────
@app.websocket("/ws/{user_id}/{session_id}")
async def websocket_endpoint(
    websocket: WebSocket,
    user_id: str,
    session_id: str,
    is_audio: bool = False,
):
    await websocket.accept()
    print(f"\n[WS] Connected: user={user_id[:8]}...")

    # Create a fresh ADK session for this connection
    session = await session_service.get_session(
        app_name=APP_NAME, user_id=user_id, session_id=session_id
    )
    if not session:
        await session_service.create_session(
            app_name=APP_NAME, user_id=user_id, session_id=session_id
        )

    live_queue = LiveRequestQueue()

    # ── Upstream: browser → ADK ───────────────────────────────────────────
    async def upstream_task():
        audio_chunks = 0
        try:
            while True:
                message = await websocket.receive()

                # Binary frame = raw PCM audio from mic
                if "bytes" in message and message["bytes"]:
                    audio_chunks += 1
                    if audio_chunks % 50 == 1:
                        print(f"[UP] Audio chunk #{audio_chunks} ({len(message['bytes'])} bytes)")
                    audio_blob = genai_types.Blob(
                        mime_type="audio/pcm;rate=16000",
                        data=message["bytes"],
                    )
                    # send_realtime lets ADK's VAD decide when to respond
                    live_queue.send_realtime(audio_blob)

                # Text frame = JSON from browser
                elif "text" in message and message["text"]:
                    data = json.loads(message["text"])
                    msg_type = data.get("type")

                    if msg_type == "text":
                        print(f"[UP] Text: {data['text']}")
                        content = genai_types.Content(
                            role="user",
                            parts=[genai_types.Part(text=data["text"])]
                        )
                        live_queue.send_content(content)

                    elif msg_type == "end_of_turn":
                        # With ADK runner + VAD, we don't need to do anything special here.
                        # The VAD detects silence and responds automatically.
                        # But we log it for debugging visibility.
                        print(f"[UP] end_of_turn received (ADK VAD handles this automatically, {audio_chunks} chunks sent)")

        except WebSocketDisconnect:
            print(f"[UP] Client disconnected")
        except Exception as e:
            print(f"[UP] Error: {e}")
        finally:
            live_queue.close()

    # ── Downstream: ADK → browser ─────────────────────────────────────────
    async def downstream_task():
        event_count = 0
        try:
            async for event in runner.run_live(
                user_id=user_id,
                session_id=session_id,
                live_request_queue=live_queue,
                run_config=RUN_CONFIG,
            ):
                event_count += 1

                # Serialize the ADK Event to JSON and send raw to browser.
                # The browser's app.js parses ADK Event fields directly:
                #   event.inputTranscription.text  → user speech transcript
                #   event.outputTranscription.text → agent speech transcript
                #   event.content.parts[].inlineData → audio bytes (base64)
                #   event.content.parts[].text      → text response
                #   event.turnComplete              → turn done
                #   event.interrupted               → agent was interrupted
                event_json = event.model_dump_json(exclude_none=True, by_alias=True)

                # Log non-audio events to server console
                event_dict = json.loads(event_json)
                if event_dict.get("turnComplete"):
                    print(f"[DOWN] ✅ Turn complete (event #{event_count})")
                elif event_dict.get("interrupted"):
                    print(f"[DOWN] ⚡ Interrupted")
                elif event_dict.get("inputTranscription"):
                    t = event_dict["inputTranscription"]
                    print(f"[DOWN] User transcript: '{t.get('text','')}' finished={t.get('finished')}")
                elif event_dict.get("outputTranscription"):
                    t = event_dict["outputTranscription"]
                    print(f"[DOWN] Agent transcript: '{t.get('text','')}' finished={t.get('finished')}")
                elif event_dict.get("content"):
                    parts = event_dict["content"].get("parts", [])
                    for p in parts:
                        if p.get("text"):
                            print(f"[DOWN] Text: {p['text'][:80]}")
                        if p.get("inlineData"):
                            size = len(p["inlineData"].get("data", "")) * 3 // 4
                            print(f"[DOWN] Audio: ~{size} bytes")

                await websocket.send_text(event_json)

        except WebSocketDisconnect:
            print(f"[DOWN] Client disconnected after {event_count} events")
        except Exception as e:
            err_str = str(e)
            # ADK raises APIError 1000 on normal WS close — safe to ignore
            if "1000" in err_str:
                print(f"[DOWN] Session closed normally after {event_count} events")
            else:
                print(f"[DOWN] Error after {event_count} events: {e}")
                try:
                    await websocket.send_text(json.dumps({"type": "error", "message": str(e)}))
                except Exception:
                    pass

    try:
        await asyncio.gather(upstream_task(), downstream_task())
    except WebSocketDisconnect:
        print(f"[WS] Client disconnected")
    except Exception as e:
        print(f"[WS] Unexpected error: {e}")
    finally:
        live_queue.close()

    print(f"[WS] Disconnected: user={user_id[:8]}...")


# ── Frontend ──────────────────────────────────────────────────────────────────
@app.get("/")
async def index():
    html_path = Path(__file__).parent / "static" / "index.html"
    if not html_path.exists():
        return HTMLResponse("<h1>index.html not found in app/static/</h1>", status_code=404)
    return HTMLResponse(html_path.read_text(encoding="utf-8"))


@app.get("/session")
async def new_session():
    """Generate fresh session & user IDs for the client."""
    return {"user_id": str(uuid.uuid4()), "session_id": str(uuid.uuid4())}