from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    crm_webhook_url: str = "http://localhost:8000/webhooks/channel-events"
    webhook_hmac_secret: str = "dev-shared-secret-change-me"
    app_env: str = "local"
    app_port: int = 8001


settings = Settings()
