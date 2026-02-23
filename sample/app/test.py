"""
Minimal Gemini Live API test — uses correct send() API for google-genai 1.x
Run: python app/test.py
"""

import asyncio
import os
from dotenv import load_dotenv
load_dotenv(override=True)

import google.genai as genai
from google.genai import types as genai_types


async def test_live():
    print("\n" + "="*60)
    print("TEST: Direct Gemini Live API - text input")
    print("="*60)

    model    = os.getenv("AGENT_MODEL", "gemini-live-2.5-flash-native-audio")
    project  = os.getenv("GOOGLE_CLOUD_PROJECT", "")
    location = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")

    print(f"  MODEL    : {model}")
    print(f"  PROJECT  : {project}")
    print(f"  LOCATION : {location}")

    client = genai.Client(vertexai=True, project=project, location=location)

    config = genai_types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        speech_config=genai_types.SpeechConfig(language_code="en-US"),
        output_audio_transcription=genai_types.AudioTranscriptionConfig(),
    )

    event_count = 0

    async with client.aio.live.connect(model=model, config=config) as session:
        print(" Connected!\n")

        # ✅ FIX: Use send_client_content instead of deprecated session.send()
        await session.send_client_content(
            turns=genai_types.Content(
                role="user",
                parts=[genai_types.Part(text="Say hello in one short sentence.")]
            ),
            turn_complete=True,
        )
        print("Sent text message, waiting for response...\n")

        async def receive():
            nonlocal event_count
            async for response in session.receive():
                event_count += 1
                print(f" Event #{event_count}: {type(response).__name__}")

                if hasattr(response, "server_content") and response.server_content:
                    sc = response.server_content

                    if hasattr(sc, "output_transcription") and sc.output_transcription:
                        t = sc.output_transcription
                        text = getattr(t, "text", "") or ""
                        if text and text != "None":
                            print(f"   Agent transcript: '{text}'")

                    if hasattr(sc, "model_turn") and sc.model_turn:
                        for part in sc.model_turn.parts:
                            if hasattr(part, "text") and part.text:
                                print(f"   Text: {part.text}")
                            if hasattr(part, "inline_data") and part.inline_data:
                                print(f"   Audio: {len(part.inline_data.data)} bytes")

                    if getattr(sc, "turn_complete", False):
                        print(f"\n TURN COMPLETE — Gemini Live is working!")
                        return

                if event_count >= 30:
                    print("(reached 30 events, stopping)")
                    return

        try:
            await asyncio.wait_for(receive(), timeout=15.0)
        except asyncio.TimeoutError:
            print(f"\n Timeout — {event_count} events received")
            if event_count == 0:
                print(" Zero events — model not responding")

    print(f"\nDone. Total events: {event_count}")


async def test_adk():
    print("\n" + "="*60)
    print("TEST: ADK Runner - text input")
    print("="*60)

    from google.adk.agents import Agent, LiveRequestQueue
    from google.adk.runners import Runner
    from google.adk.sessions import InMemorySessionService
    from google.adk.agents.run_config import RunConfig

    model = os.getenv("AGENT_MODEL", "gemini-live-2.5-flash-native-audio")
    print(f"  MODEL: {model}")

    test_agent = Agent(
        name="test_agent",
        model=model,
        instruction="You are a test assistant. Reply in one short sentence.",
    )

    session_service = InMemorySessionService()
    runner = Runner(app_name="test", agent=test_agent, session_service=session_service)

    # ✅ FIX: Still create session but use user_id/session_id in run_live (avoids deprecated warning)
    await session_service.create_session(
        app_name="test", user_id="test-user", session_id="test-session"
    )

    run_config = RunConfig(
        response_modalities=["AUDIO"],
        speech_config=genai_types.SpeechConfig(language_code="en-US"),
        output_audio_transcription=genai_types.AudioTranscriptionConfig(),
    )

    live_queue = LiveRequestQueue()
    event_count = 0

    async def sender():
        await asyncio.sleep(2)
        print("  Sending text via ADK...")
        live_queue.send_content(
            genai_types.Content(
                role="user",
                parts=[genai_types.Part(text="Hello, say one sentence.")]
            )
        )
        # Give enough time for full response before closing
        await asyncio.sleep(15)
        live_queue.close()

    async def receiver():
        nonlocal event_count
        try:
            # ✅ FIX: Use user_id + session_id instead of deprecated session= parameter
            async for event in runner.run_live(
                user_id="test-user",
                session_id="test-session",
                live_request_queue=live_queue,
                run_config=run_config,
            ):
                event_count += 1
                print(f"   ADK Event #{event_count}: {type(event).__name__}")

                # ADK wraps responses differently — check both access patterns
                sc = None
                if hasattr(event, "server_content") and event.server_content:
                    sc = event.server_content
                elif hasattr(event, "content") and event.content:
                    print(f"     Content role: {getattr(event.content, 'role', '?')}")

                if sc:
                    if hasattr(sc, "output_transcription") and sc.output_transcription:
                        text = getattr(sc.output_transcription, "text", "") or ""
                        if text and text != "None":
                            print(f"    Agent transcript: '{text}'")
                    if hasattr(sc, "model_turn") and sc.model_turn:
                        for part in sc.model_turn.parts:
                            if hasattr(part, "inline_data") and part.inline_data:
                                print(f"     Audio: {len(part.inline_data.data)} bytes")
                            if hasattr(part, "text") and part.text:
                                print(f"      Text: {part.text}")
                    if getattr(sc, "turn_complete", False):
                        print(f"      ADK TURN COMPLETE — pipeline works!")
                        live_queue.close()
                        return

        except Exception as e:
            err_str = str(e)
            # ✅ FIX: "APIError: 1000 None" is NOT a real error.
            # WebSocket close code 1000 = normal closure (OK).
            # ADK incorrectly raises this as an exception when live_queue.close()
            # triggers a clean shutdown. Safe to treat as success.
            if "1000" in err_str:
                print(f" Session closed normally (WS 1000 = OK) — {event_count} events received")
                if event_count == 0:
                    print("No events before close — try increasing sender sleep time")
            else:
                print(f" Unexpected ADK error: {e}")
                raise

    try:
        await asyncio.wait_for(asyncio.gather(sender(), receiver()), timeout=25.0)
    except asyncio.TimeoutError:
        print(f"  ⏰ Timeout — {event_count} ADK events received")
        if event_count == 0:
            print("Zero events — check model name and credentials")
        else:
            print("Got events but no turn_complete yet — model still processing")

    print(f"  Total ADK events: {event_count}")


if __name__ == "__main__":
    async def main():
        await test_live()
        await test_adk()
    asyncio.run(main())