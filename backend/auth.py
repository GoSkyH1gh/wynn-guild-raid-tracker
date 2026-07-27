import logging
import os
import urllib.parse
from datetime import datetime, timedelta, timezone

import httpx
import jwt
from dotenv import load_dotenv
from fastapi import HTTPException, Request
from sqlalchemy import select

from .database import AsyncSessionLocal
from .models import DiscordUser

load_dotenv()

logger = logging.getLogger(__name__)

JWT_SECRET = os.getenv("JWT_SECRET", "change-me-in-production")
JWT_ALGORITHM = "HS256"
SESSION_EXPIRE_DAYS = 30

DISCORD_CLIENT_ID = os.getenv("DISCORD_CLIENT_ID", "")
DISCORD_CLIENT_SECRET = os.getenv("DISCORD_CLIENT_SECRET", "")
DISCORD_REDIRECT_URI = os.getenv(
    "DISCORD_REDIRECT_URI",
    "http://localhost:8000/api/auth/discord/callback",
)
DISCORD_AUTHORIZE_URL = "https://discord.com/api/oauth2/authorize"
DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token"
DISCORD_USER_URL = "https://discord.com/api/users/@me"

SETUP_SECRET = os.getenv("SETUP_SECRET", "")

AUTHORIZED_DISCORD_IDS: set[str] = set()
_raw = os.getenv("AUTHORIZED_DISCORD_IDS", "")
if _raw:
    AUTHORIZED_DISCORD_IDS = {x.strip() for x in _raw.split(",") if x.strip()}


def create_jwt(discord_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=SESSION_EXPIRE_DAYS)
    payload = {"sub": discord_id, "exp": expire}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_jwt(token: str) -> dict | None:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None


def discord_login_url() -> str:
    params = urllib.parse.urlencode({
        "client_id": DISCORD_CLIENT_ID,
        "redirect_uri": DISCORD_REDIRECT_URI,
        "response_type": "code",
        "scope": "identify",
    })
    return f"{DISCORD_AUTHORIZE_URL}?{params}"


async def exchange_code(code: str) -> dict | None:
    data = {
        "client_id": DISCORD_CLIENT_ID,
        "client_secret": DISCORD_CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": DISCORD_REDIRECT_URI,
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.post(DISCORD_TOKEN_URL, data=data, headers=headers, timeout=15)
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as e:
            logger.error("Discord token exchange failed: %s %s", e.response.status_code, e.response.text[:300])
            return None
        except httpx.RequestError as e:
            logger.error("Discord token exchange request error: %s", e)
            return None


async def get_discord_user(access_token: str) -> dict | None:
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(DISCORD_USER_URL, headers=headers, timeout=15)
            resp.raise_for_status()
            return resp.json()
        except httpx.HTTPStatusError as e:
            logger.error("Discord user fetch failed: %s %s", e.response.status_code, e.response.text[:300])
            return None
        except httpx.RequestError as e:
            logger.error("Discord user fetch request error: %s", e)
            return None


async def get_current_user(request: Request) -> dict:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")
    token = auth[7:]
    payload = decode_jwt(token)
    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(DiscordUser).where(DiscordUser.discord_id == payload["sub"])
        )
        user = result.scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=401, detail="User not authorized")
        return {
            "discord_id": user.discord_id,
            "username": user.username,
            "avatar_url": user.avatar_url,
            "is_admin": user.is_admin,
        }


async def get_admin_user(request: Request) -> dict:
    user = await get_current_user(request)
    if not user["is_admin"]:
        raise HTTPException(status_code=403, detail="Admin access required")
    return user
