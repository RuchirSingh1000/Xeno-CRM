"""Provider-agnostic LLM client with automatic fallback.

Order of resolution on every call:
  1. Try the configured primary provider (anthropic | openai | gemini)
  2. If the primary raises (rate limit, auth, network, anything), and Groq is
     configured, retry the same prompt against Groq with `gpt-oss-120b`.
  3. If Groq also fails or isn't configured, raise — the service-level handler
     produces a deterministic fallback and marks the audit row appropriately.

Why fallback at the client layer instead of in each service:
- Every AI surface (segment planner, campaign planner, merge explainer,
  campaign analyst) gets the same resilience without copying retry code.
- The audit row records *which provider actually served the response* via
  `llm.last_used_provider`, so post-hoc you can see "Gemini rate-limited, Groq
  saved the day" rather than the configured provider name lying about reality.
- Stub mode is preserved untouched: with no API keys at all, every call
  returns a deterministic dict so the app boots cleanly for dev / recording.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from app.config import settings

logger = logging.getLogger("llm")


class LLMClient:
    def __init__(self) -> None:
        self.provider = settings.llm_provider
        # Recorded after every call so services can audit the actually-used
        # provider/model (which may differ from the configured one after fallback).
        self.last_used_provider: str = ""
        self.last_used_model: str = ""

    def has_credentials(self) -> bool:
        """True if the *primary* provider has a key. Groq alone counts too —
        it's the fallback layer, but in stub-less environments where only Groq
        is set, we still want has_credentials() to read as 'real LLM available'."""
        if self.provider == "anthropic" and settings.anthropic_api_key:
            return True
        if self.provider == "openai" and settings.openai_api_key:
            return True
        if self.provider == "gemini" and settings.gemini_api_key:
            return True
        if self.provider == "groq" and settings.groq_api_key:
            return True
        if settings.groq_api_key:
            return True  # Groq is the universal fallback
        return False

    def complete_json(
        self,
        system: str,
        user: str,
        schema_hint: dict | None = None,
        force_provider: str | None = None,
    ) -> dict[str, Any]:
        """Try primary provider; on failure, transparently try Groq.

        Sets `self.last_used_provider` and `self.last_used_model` to reflect what
        actually served the request — services use these to write accurate AIRun
        audit rows.

        `force_provider` skips the configured primary and uses the named provider
        directly. Used by services that retry after a validation failure: rather
        than re-asking Gemini (which just returned invalid JSON), ask Groq instead.
        """
        self.last_used_provider = ""
        self.last_used_model = ""

        # Forced provider — skip the primary stack, go straight to the named one.
        if force_provider:
            if force_provider == "groq" and settings.groq_api_key:
                result = self._groq(system, user, schema_hint)
                self.last_used_provider = "groq"
                self.last_used_model = settings.llm_model_groq
                return result
            if force_provider == "gemini" and settings.gemini_api_key:
                result = self._gemini(system, user, schema_hint)
                self.last_used_provider = "gemini"
                self.last_used_model = settings.llm_model_gemini
                return result
            if force_provider == "openai" and settings.openai_api_key:
                result = self._openai(system, user, schema_hint)
                self.last_used_provider = "openai"
                self.last_used_model = settings.llm_model_openai
                return result
            if force_provider == "anthropic" and settings.anthropic_api_key:
                result = self._anthropic(system, user, schema_hint)
                self.last_used_provider = "anthropic"
                self.last_used_model = settings.llm_model_anthropic
                return result
            raise RuntimeError(f"force_provider={force_provider!r} not available")

        primary_provider = self.provider
        primary_error: Exception | None = None

        # 1. Primary attempt
        try:
            if primary_provider == "anthropic" and settings.anthropic_api_key:
                result = self._anthropic(system, user, schema_hint)
                self.last_used_provider = "anthropic"
                self.last_used_model = settings.llm_model_anthropic
                return result
            if primary_provider == "openai" and settings.openai_api_key:
                result = self._openai(system, user, schema_hint)
                self.last_used_provider = "openai"
                self.last_used_model = settings.llm_model_openai
                return result
            if primary_provider == "gemini" and settings.gemini_api_key:
                result = self._gemini(system, user, schema_hint)
                self.last_used_provider = "gemini"
                self.last_used_model = settings.llm_model_gemini
                return result
            if primary_provider == "groq" and settings.groq_api_key:
                result = self._groq(system, user, schema_hint)
                self.last_used_provider = "groq"
                self.last_used_model = settings.llm_model_groq
                return result
        except Exception as e:
            primary_error = e
            logger.warning(
                f"primary provider '{primary_provider}' failed: "
                f"{type(e).__name__}: {e}. Trying Groq fallback…"
            )

        # 2. Groq fallback (only if primary failed AND Groq is configured AND
        #    Groq wasn't already the primary)
        if primary_error is not None and primary_provider != "groq" and settings.groq_api_key:
            try:
                result = self._groq(system, user, schema_hint)
                self.last_used_provider = "groq"
                self.last_used_model = settings.llm_model_groq
                logger.info(f"Groq fallback served the request ({settings.llm_model_groq})")
                return result
            except Exception as e:
                logger.warning(f"Groq fallback also failed: {type(e).__name__}: {e}")
                raise RuntimeError(
                    f"primary={type(primary_error).__name__}({primary_error}); "
                    f"groq_fallback={type(e).__name__}({e})"
                ) from primary_error

        # 3. Primary failed and no Groq fallback available — propagate
        if primary_error is not None:
            raise primary_error

        # 4. No real provider configured at all — deterministic stub
        result = self._stub(user, schema_hint)
        self.last_used_provider = "stub"
        self.last_used_model = "stub"
        return result

    # --- per-provider implementations ---

    def _anthropic(self, system: str, user: str, schema_hint: dict | None) -> dict[str, Any]:
        import anthropic

        client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
        prompt_user = user
        if schema_hint:
            prompt_user += f"\n\nReturn ONLY valid JSON matching this schema:\n{json.dumps(schema_hint)}"
        resp = client.messages.create(
            model=settings.llm_model_anthropic,
            max_tokens=2048,
            system=system,
            messages=[{"role": "user", "content": prompt_user}],
        )
        text = "".join(b.text for b in resp.content if hasattr(b, "text"))
        return _extract_json(text)

    def _openai(self, system: str, user: str, schema_hint: dict | None) -> dict[str, Any]:
        from openai import OpenAI

        client = OpenAI(api_key=settings.openai_api_key)
        prompt_user = user
        if schema_hint:
            prompt_user += f"\n\nReturn ONLY valid JSON matching this schema:\n{json.dumps(schema_hint)}"
        resp = client.chat.completions.create(
            model=settings.llm_model_openai,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt_user},
            ],
        )
        return _extract_json(resp.choices[0].message.content or "{}")

    def _gemini(self, system: str, user: str, schema_hint: dict | None) -> dict[str, Any]:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=settings.gemini_api_key)
        prompt_user = user
        if schema_hint:
            prompt_user += f"\n\nReturn ONLY valid JSON matching this schema:\n{json.dumps(schema_hint)}"
        config = types.GenerateContentConfig(
            system_instruction=system,
            response_mime_type="application/json",
            temperature=0.2,
        )
        resp = client.models.generate_content(
            model=settings.llm_model_gemini,
            contents=prompt_user,
            config=config,
        )
        return _extract_json(resp.text or "{}")

    def _groq(self, system: str, user: str, schema_hint: dict | None) -> dict[str, Any]:
        """Groq via its OpenAI-compatible endpoint. Default model `openai/gpt-oss-120b`."""
        from openai import OpenAI

        client = OpenAI(
            api_key=settings.groq_api_key,
            base_url="https://api.groq.com/openai/v1",
        )
        prompt_user = user
        if schema_hint:
            prompt_user += f"\n\nReturn ONLY valid JSON matching this schema:\n{json.dumps(schema_hint)}"
        resp = client.chat.completions.create(
            model=settings.llm_model_groq,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt_user},
            ],
            temperature=0.2,
        )
        return _extract_json(resp.choices[0].message.content or "{}")

    def _stub(self, user: str, schema_hint: dict | None) -> dict[str, Any]:
        # Deterministic stub: enough structure for downstream code to run.
        # Replaced by real LLM responses once keys are configured.
        return {
            "_stub": True,
            "_note": "LLM provider not configured; deterministic stub response.",
            "audience_criteria": {"last_order_days_min": 60, "ltv_min": 2000},
            "suppression_rules": {"recently_contacted_days": 7, "exclude_dnd": True},
            "recommended_channel_priority": ["whatsapp", "sms", "email"],
            "message_angle": "We miss you — here is 15% off your next order",
            "personalization_variables": ["first_name", "last_order_days", "loyalty_tier"],
            "suggested_message_template": "Hi {{first_name}}, it's been {{last_order_days}} days! As a {{loyalty_tier}} member, here's 15% off.",
            "success_metric": "Reactivation rate within 14 days",
            "reasoning": "Stub reasoning: targeted lapsed high-value customers with consent-aware multi-channel fallback.",
        }


def _extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # last-ditch: find first { and last }
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            return json.loads(text[start : end + 1])
        raise


llm = LLMClient()
