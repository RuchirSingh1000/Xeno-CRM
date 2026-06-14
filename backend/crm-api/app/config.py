from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "sqlite:///./crm.db"
    channel_service_url: str = "http://localhost:8001"
    webhook_hmac_secret: str = "dev-shared-secret-change-me"

    llm_provider: str = "stub"  # anthropic | openai | gemini | groq | stub
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    gemini_api_key: str = ""
    groq_api_key: str = ""
    llm_model_anthropic: str = "claude-sonnet-4-6"
    llm_model_openai: str = "gpt-4o-mini"
    llm_model_gemini: str = "gemini-2.5-flash"
    llm_model_groq: str = "openai/gpt-oss-120b"

    def model_for(self, provider: str) -> str:
        """Return the configured model name for a provider — used by AIRun audit rows."""
        if provider == "anthropic":
            return self.llm_model_anthropic
        if provider == "openai":
            return self.llm_model_openai
        if provider == "gemini":
            return self.llm_model_gemini
        if provider == "groq":
            return self.llm_model_groq
        return "stub"

    @property
    def retry_provider(self) -> str | None:
        """Provider to use for the validation-failure retry.

        If the primary returned malformed JSON, retrying the same provider is
        usually fruitless. Groq (when configured) is a different model family
        on a different vendor, so the structural failure mode rarely repeats.
        Returns None if we're already on Groq or have no Groq key.
        """
        if self.llm_provider == "groq":
            return None
        if self.groq_api_key:
            return "groq"
        return None

    allowed_origins: str = "http://localhost:3000,http://127.0.0.1:3000"
    app_env: str = "local"
    app_port: int = 8000

    # Data directory (seed CSVs)
    data_dir: str = "../../data"

    @property
    def origins_list(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",") if o.strip()]


settings = Settings()
