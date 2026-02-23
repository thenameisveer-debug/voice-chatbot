"""
Voice Chatbot Backend - FastAPI + Google ADK runner.run_live()
Uses ADK's built-in VAD — no manual end_of_turn signaling needed.
Run with: uvicorn app.main:app --reload
"""

import asyncio
import json
import os
import uuid
import warnings
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(override=True)

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import List

from app.agents.agent import voice_agent
from app.agents.output_refiner import OutputRefinerAgent
from google.adk.agents.live_request_queue import LiveRequestQueue
from app.api.file_upload import router as documents_router
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

if USE_VERTEX:
    os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "TRUE"
    os.environ["GOOGLE_CLOUD_PROJECT"]      = PROJECT
    os.environ["GOOGLE_CLOUD_LOCATION"]     = LOCATION

print(f"[INIT] Model: {MODEL} | Vertex: {USE_VERTEX} | Project: {PROJECT}")

session_service = InMemorySessionService()
runner = Runner(app_name=APP_NAME, agent=voice_agent, session_service=session_service)

# ── OutputRefinerAgent singleton ──────────────────────────────────────────────
output_refiner = OutputRefinerAgent()

# ── FastAPI app ────────────────────────────────────────────────────────────────
app = FastAPI(title="Voice Chatbot")

static_path = Path(__file__).parent / "static"
static_path.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(static_path)), name="static")
app.include_router(documents_router)

# ── RunConfig ─────────────────────────────────────────────────────────────────
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

# ── Refine answers endpoint ───────────────────────────────────────────────────
class AnswerItem(BaseModel):
    question: str
    answer: str
    ground_truth: str

class RefineRequest(BaseModel):
    answers: List[AnswerItem]

@app.post("/refine-answers")
async def refine_answers(request: RefineRequest):
    raw = [item.model_dump() for item in request.answers]
    refined = await output_refiner.refine(raw)
    return JSONResponse(content={"refined": refined})


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

    session = await session_service.get_session(
        app_name=APP_NAME, user_id=user_id, session_id=session_id
    )
    if not session:
        await session_service.create_session(
            app_name=APP_NAME, user_id=user_id, session_id=session_id
        )

    live_queue = LiveRequestQueue()

    async def upstream_task():
        audio_chunks = 0
        try:
            while True:
                message = await websocket.receive()

                if "bytes" in message and message["bytes"]:
                    audio_chunks += 1
                    if audio_chunks % 50 == 1:
                        print(f"[UP] Audio chunk #{audio_chunks} ({len(message['bytes'])} bytes)")
                    audio_blob = genai_types.Blob(
                        mime_type="audio/pcm;rate=16000",
                        data=message["bytes"],
                    )
                    live_queue.send_realtime(audio_blob)

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
                        print(f"[UP] end_of_turn received ({audio_chunks} chunks sent)")

        except WebSocketDisconnect:
            print(f"[UP] Client disconnected")
        except Exception as e:
            print(f"[UP] Error: {e}")
        finally:
            live_queue.close()

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
                event_json = event.model_dump_json(exclude_none=True, by_alias=True)

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

                await websocket.send_text(event_json)

        except WebSocketDisconnect:
            print(f"[DOWN] Client disconnected after {event_count} events")
        except Exception as e:
            err_str = str(e)
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
    return {"user_id": str(uuid.uuid4()), "session_id": str(uuid.uuid4())}