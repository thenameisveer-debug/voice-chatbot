import asyncio
import json
import os
from typing import Any

from google.adk.agents.llm_agent import Agent
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai.types import Content, Part

from app.config.config import Config
from app.src.adapters.logger import logger as log
from app.src.utils import decode_json

# ── Constants ─────────────────────────────────────────────────────────────────

_MODEL        = "gemini-2.5-flash"
_APP_NAME     = "form_refiner_app"
_MAX_RETRIES  = 3
_BACKOFF_BASE = 2   # seconds: 2 → 4 → 8

# ── Tool ──────────────────────────────────────────────────────────────────────

def clean_form_answers(raw_json: str) -> str:
    """
    Accepts the raw answers JSON string — array of {question, answer, ground_truth}.
    Signals the agent to clean only the 'answer' field of each item.
    ground_truth is always preserved as-is.
    fileUpload answers (URLs) are never modified.
    """
    try:
        data = json.loads(raw_json)
        log.info(f"[OutputRefiner] Tool called — {len(data)} answers to clean")
        return f"Received {len(data)} answers. Clean each 'answer' field and return the JSON array."
    except json.JSONDecodeError as e:
        return f"Invalid JSON: {e}"


# ── Agent instruction ─────────────────────────────────────────────────────────

_INSTRUCTION = """
You are a form answer cleaner agent.

You receive a JSON array where each item has:
  - "question"     : the form field label (never modify)
  - "answer"       : raw conversational user speech (clean this)
  - "ground_truth" : original raw text (NEVER modify — always keep as-is)

Your job:
1. Call the `clean_form_answers` tool with the full JSON string.
2. After the tool responds, output ONLY the cleaned JSON array — no markdown, no explanation, no backticks.

═══ CLEANING RULES for the "answer" field only ═══

Extract ONLY the bare data value — strip all conversational filler:

Leading filler to remove (non-exhaustive):
  "my name is X"                    → X
  "the name of institute is X"      → X
  "the name of the person is X"     → X
  "the address is X"                → X
  "address is the X"                → X
  "email id would be X"             → X
  "the email is X"                  → X
  "okay, the email address of Y is X" → X
  "the phone number is X"           → X
  "okay, the contact number is X"   → X
  "my password is X"                → X
  "okay, the password will be X"    → X
  "the uaepass id is X"             → X
  "okay, the UAE pass ID will be X" → X
  "it is a X"                       → X
  "I'd go with X"                   → X

Trailing filler to remove (non-exhaustive):
  "X should be the username"        → X
  "X will be my ID"                 → X
  "X is my password"                → X
  "X for the account"               → X
  "X would be my username"          → X

Negation / boolean answers:
  "No, it doesn't have a UAE pass account." → "No"
  "Yes, the user has an existing account."  → "Yes"

Special rules:
  - If "answer" starts with http:// or https:// → it is a file URL, copy it unchanged.
  - select/radio answers must match one of the known option strings exactly (correct casing).
  - "ground_truth" field: copy the original value verbatim — never alter it.
  - "question" field: copy verbatim — never alter it.
  - Output must be a valid JSON array with exactly the same number of items as input.

═══ EXAMPLES ═══
Input item:
  {"question": "Please provide the full name of the institution.",
   "answer": "The full name of the institution is xebia.",
   "ground_truth": "The full name of the institution is xebia."}
Output item:
  {"question": "Please provide the full name of the institution.",
   "answer": "xebia",
   "ground_truth": "The full name of the institution is xebia."}

Input item:
  {"question": "Select the type of institution.",
   "answer": "It is a college.",
   "ground_truth": "It is a college."}
Output item:
  {"question": "Select the type of institution.",
   "answer": "College",
   "ground_truth": "It is a college."}

Input item:
  {"question": "Upload a copy of the institution's license.",
   "answer": "https://storage.googleapis.com/bucket/file.pdf",
   "ground_truth": "https://storage.googleapis.com/bucket/file.pdf"}
Output item:
  {"question": "Upload a copy of the institution's license.",
   "answer": "https://storage.googleapis.com/bucket/file.pdf",
   "ground_truth": "https://storage.googleapis.com/bucket/file.pdf"}
"""


# ── Agent class ───────────────────────────────────────────────────────────────

class OutputRefinerAgent:
    """
    ADK LlmAgent that cleans conversational filler from form answers.

    Input:  list of {question, answer, ground_truth}
    Output: same list with 'answer' fields cleaned; ground_truth always unchanged.
    """

    def __init__(self):
        if not os.environ.get("GOOGLE_API_KEY"):
            os.environ["GOOGLE_API_KEY"] = Config.GOOGLE_API_KEY

        self._agent = Agent(
            model=_MODEL,
            name="output_refiner_agent",
            description="Cleans conversational filler from form answer values",
            instruction=_INSTRUCTION,
            tools=[clean_form_answers],
        )
        self._session_service = InMemorySessionService()
        self._runner = Runner(
            agent=self._agent,
            app_name=_APP_NAME,
            session_service=self._session_service,
        )
        log.info(f"[OutputRefiner] Agent initialised — model: {_MODEL}")

    async def refine(self, raw_answers: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """
        Clean the 'answer' field of each item in raw_answers.
        Retries up to _MAX_RETRIES times with exponential backoff on 429.
        Falls back to raw_answers if all attempts fail.
        """
        raw_json = json.dumps(raw_answers, indent=2)
        prompt = (
            "Here is the raw form answers array. Each item has question, answer, and ground_truth.\n"
            "Call clean_form_answers tool, then return the cleaned JSON array.\n\n"
            + raw_json
        )

        for attempt in range(1, _MAX_RETRIES + 1):
            try:
                result = await self._run_agent(prompt, attempt, raw_answers)
                if result is not raw_answers:
                    log.info(f"[OutputRefiner] Cleaned successfully on attempt {attempt}")
                    return result
            except Exception as e:
                err_str  = str(e)
                is_429   = "429" in err_str or "RESOURCE_EXHAUSTED" in err_str
                is_daily = "limit: 0" in err_str

                if is_daily:
                    log.error("[OutputRefiner] Daily quota exhausted — returning raw answers")
                    return raw_answers

                if is_429 and attempt < _MAX_RETRIES:
                    wait = self._retry_delay(err_str) or (_BACKOFF_BASE ** attempt)
                    log.warning(f"[OutputRefiner] 429 attempt {attempt}/{_MAX_RETRIES} — retrying in {wait}s")
                    await asyncio.sleep(wait)
                    continue

                log.warning(f"[OutputRefiner] Attempt {attempt} failed: {e}")

        log.error("[OutputRefiner] All attempts failed — returning raw answers")
        return raw_answers

    async def _run_agent(
        self,
        prompt: str,
        attempt: int,
        fallback: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        """Create a fresh session, run the agent, return parsed JSON list."""
        session_id = f"refiner-{attempt}-{id(prompt)}"

        await self._session_service.create_session(
            app_name=_APP_NAME,
            user_id="refiner_user",
            session_id=session_id,
        )

        message    = Content(role="user", parts=[Part(text=prompt)])
        final_text = ""

        async for event in self._runner.run_async(
            user_id="refiner_user",
            session_id=session_id,
            new_message=message,
        ):
            if event.is_final_response() and event.content and event.content.parts:
                final_text = event.content.parts[0].text.strip()
                break

        if not final_text:
            log.warning("[OutputRefiner] Agent returned empty response")
            return fallback

        log.info(f"[OutputRefiner] Raw response ({len(final_text)} chars)")
        result = decode_json(final_text)

        # Validate it's a list with the right shape
        if not isinstance(result, list) or not result:
            log.warning("[OutputRefiner] Unexpected response shape — returning fallback")
            return fallback

        # Safety: ensure ground_truth is never altered
        for i, item in enumerate(result):
            if i < len(fallback):
                item["ground_truth"] = fallback[i]["ground_truth"]

        return result

    @staticmethod
    def _retry_delay(err_str: str) -> float | None:
        """Extract retryDelay seconds from the API error string if present."""
        import re
        m = re.search(r"'retryDelay':\s*'(\d+)s'", err_str)
        if m:
            return float(m.group(1))
        m = re.search(r"retry(?:ing)? in (\d+(?:\.\d+)?)s", err_str, re.IGNORECASE)
        if m:
            return float(m.group(1))
        return None