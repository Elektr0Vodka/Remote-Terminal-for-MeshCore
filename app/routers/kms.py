from fastapi import APIRouter, HTTPException

from app.models import KmsKey, KmsKeyCreate, KmsKeyUpdate
from app.repository.kms import KmsRepository

router = APIRouter(prefix="/kms", tags=["kms"])


@router.get("/keys", response_model=list[KmsKey])
async def list_keys() -> list[KmsKey]:
    return await KmsRepository.get_all()


@router.post("/keys", response_model=KmsKey, status_code=201)
async def create_key(body: KmsKeyCreate) -> KmsKey:
    if len(body.public_key) != 64:
        raise HTTPException(status_code=422, detail="public_key must be 64 hex characters")
    if len(body.private_key) != 128:
        raise HTTPException(status_code=422, detail="private_key must be 128 hex characters")
    return await KmsRepository.create(body)


@router.get("/keys/{key_id}", response_model=KmsKey)
async def get_key(key_id: int) -> KmsKey:
    key = await KmsRepository.get_by_id(key_id)
    if not key:
        raise HTTPException(status_code=404, detail="Key not found")
    return key


@router.patch("/keys/{key_id}", response_model=KmsKey)
async def update_key(key_id: int, body: KmsKeyUpdate) -> KmsKey:
    key = await KmsRepository.update(key_id, body)
    if not key:
        raise HTTPException(status_code=404, detail="Key not found")
    return key


@router.delete("/keys/{key_id}", status_code=204)
async def delete_key(key_id: int) -> None:
    deleted = await KmsRepository.delete(key_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Key not found")
