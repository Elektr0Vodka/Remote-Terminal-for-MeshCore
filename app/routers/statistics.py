from fastapi import APIRouter, Query

from app.models import StatisticsResponse
from app.repository import StatisticsRepository
from app.repository.noise_floor import NoiseFloorRepository
from app.services.radio_stats import get_battery_history, get_noise_floor_history

router = APIRouter(prefix="/statistics", tags=["statistics"])


@router.get("", response_model=StatisticsResponse)
async def get_statistics() -> StatisticsResponse:
    data = await StatisticsRepository.get_all()
    data["noise_floor_24h"] = get_noise_floor_history()
    return StatisticsResponse(**data)


@router.get("/battery")
async def get_battery_history_endpoint() -> dict:
    return get_battery_history()


@router.get("/noise-floor")
async def get_noise_floor_range(
    start_ts: int = Query(..., description="Start timestamp (Unix seconds)"),
    end_ts: int = Query(..., description="End timestamp (Unix seconds)"),
) -> list[dict]:
    return await NoiseFloorRepository.get_range(start_ts, end_ts)
