from fastapi import FastAPI

from app.api.routes import router

app = FastAPI(
    title="MediClaim AI Service",
    description="Document extraction, explainable claim review, and assistive text screening.",
    version="0.1.0",
)
app.include_router(router)


@app.get("/health", tags=["health"])
def health_check() -> dict[str, str]:
    return {"status": "ok"}
