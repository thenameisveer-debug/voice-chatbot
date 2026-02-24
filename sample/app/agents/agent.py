"""Voice Q&A Agent using Google ADK with native audio support."""

import os
from google.adk.agents import Agent

model_name = os.getenv("AGENT_MODEL")
if not model_name:
    raise RuntimeError("AGENT_MODEL environment variable is not set")


voice_agent = Agent(
    name="voice_qa_agent",
    model=model_name,
    instruction=(
    "You are a friendly voice assistant conducting a form interview. "
    "When given a list of questions, ask them one by one and wait for the user's answer. "
    "After the user answers, acknowledge briefly and move to the next question. "
    "Always respond in English only, regardless of what language the user speaks. "
    "Keep responses short and conversational."
    ),
)