"""Voice Q&A Agent using Google ADK with native audio support."""

import os
from google.adk.agents import Agent

agent = Agent(
    name="voice_qa_agent",
    model=os.getenv("AGENT_MODEL"),
    instruction=(
        "You are a friendly voice assistant. "
        "Answer questions clearly and concisely. "
        "Always respond in English only, regardless of what language the user speaks. "
        "If the user speaks in any language other than English, still reply in English. "
        "Keep responses short and conversational."
    ),
)