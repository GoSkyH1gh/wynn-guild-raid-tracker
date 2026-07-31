import logging
import os
import secrets
import urllib.parse
from datetime import datetime, timedelta, timezone

import httpx
import jwt
from dotenv import load_dotenv
from fastapi import HTTPException, Request, Response
from sqlalchemy import select

from .database import AsyncSessionLocal
from .models import DiscordUser

load_dotenv()

logger = logging.getLogger(__name__)

JWT_SECRET = os.getenv("JWT_SECRET")
if not JWT_SECRET:
    raise RuntimeError("JWT_SECRET must be set in the environment")
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

_oauth_states: dict[str, datetime] = {}
OAUTH_STATE_TTL_SECONDS = 10 * 60
MAX_OAUTH_STATES = 10_000


def _prune_oauth_states() -> None:
    now = datetime.now(timezone.utc)
    expired = [k for k, expires_at in _oauth_states.items() if expires_at <= now]
    for k in expired:
        _oauth_states.pop(k, None)


def create_oauth_state() -> str:
    _prune_oauth_states()
    if len(_oauth_states) >= MAX_OAUTH_STATES:
        # Evict the oldest states so a flooding attacker cannot permanently
        # exhaust memory or lock out legitimate logins.
        evict = sorted(_oauth_states, key=_oauth_states.get)[
            : len(_oauth_states) - MAX_OAUTH_STATES // 2
        ]
        for k in evict:
            _oauth_states.pop(k, None)
    state = secrets.token_urlsafe(32)
    _oauth_states[state] = datetime.now(timezone.utc) + timedelta(
        seconds=OAUTH_STATE_TTL_SECONDS
    )
    return state


def consume_oauth_state(state: str) -> bool:
    _prune_oauth_states()
    expires_at = _oauth_states.pop(state, None)
    if expires_at is None or expires_at <= datetime.now(timezone.utc):
        return False
    return True


def create_jwt(discord_id: str, token_version: int = 0) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=SESSION_EXPIRE_DAYS)
    payload = {"sub": discord_id, "exp": expire, "ver": token_version}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_jwt(token: str) -> dict | None:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        return None


def discord_login_url(state: str | None = None) -> str:
    params = {
        "client_id": DISCORD_CLIENT_ID,
        "redirect_uri": DISCORD_REDIRECT_URI,
        "response_type": "code",
        "scope": "identify",
    }
    if state:
        params["state"] = state
    return f"{DISCORD_AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


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


def _extract_jwt(request: Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:]
    token = request.cookies.get("jwt")
    if token:
        return token
    return None


def _cookie_secure() -> bool:
    if os.getenv("JWT_COOKIE_SECURE", "").strip().lower() == "true":
        return True
    return (os.getenv("FRONTEND_URL", "") or "").startswith("https://")


def _cookie_samesite() -> str:
    samesite = os.getenv("JWT_COOKIE_SAMESITE", "lax").strip().lower()
    if samesite not in ("lax", "strict", "none"):
        samesite = "lax"
    return samesite


def set_jwt_cookie(response: Response, token: str) -> None:
    samesite = _cookie_samesite()
    response.set_cookie(
        key="jwt",
        value=token,
        httponly=True,
        samesite=samesite,
        secure=_cookie_secure() or samesite == "none",
        max_age=60 * 60 * 24 * SESSION_EXPIRE_DAYS,
        path="/",
    )


def delete_jwt_cookie(response: Response) -> None:
    samesite = _cookie_samesite()
    response.delete_cookie(
        key="jwt",
        path="/",
        samesite=samesite,
        secure=_cookie_secure() or samesite == "none",
    )


async def revoke_user_token(request: Request) -> None:
    token = _extract_jwt(request)
    if not token:
        return
    payload = decode_jwt(token)
    if not payload or not payload.get("sub"):
        return
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(DiscordUser).where(DiscordUser.discord_id == payload["sub"])
        )
        user = result.scalar_one_or_none()
        if user is not None:
            user.token_version += 1
            await session.commit()


async def get_current_user(request: Request) -> dict:
    token = _extract_jwt(request)
    if token is None:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_jwt(token)
    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    discord_id = payload.get("sub")
    if not discord_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(DiscordUser).where(DiscordUser.discord_id == discord_id)
        )
        user = result.scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=401, detail="User not authorized")
        if payload.get("ver", 0) != user.token_version:
            raise HTTPException(status_code=401, detail="Session has been revoked")
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
