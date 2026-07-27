"""Async PostgreSQL setup shared by FastAPI routes and application startup."""

import os
from collections.abc import AsyncGenerator

from dotenv import load_dotenv, find_dotenv
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


load_dotenv(find_dotenv())


def _async_database_url(database_url: str) -> str:
    """Convert a standard PostgreSQL URL into SQLAlchemy's asyncpg URL."""
    if database_url.startswith("postgresql://"):
        database_url = database_url.replace("postgresql://", "postgresql+asyncpg://", 1)
    elif database_url.startswith("postgres://"):
        database_url = database_url.replace("postgres://", "postgresql+asyncpg://", 1)
    elif not database_url.startswith("postgresql+asyncpg://"):
        raise ValueError("DATABASE_URL must be a PostgreSQL connection URL")

    url = make_url(database_url)
    query = dict(url.query)
    # Hosted PostgreSQL providers commonly use libpq's sslmode=require. asyncpg
    # uses the equivalent ssl parameter instead.
    sslmode = query.pop("sslmode", None)
    # channel_binding is another libpq-specific option that asyncpg does not
    # accept. TLS is still configured through the ssl parameter above.
    query.pop("channel_binding", None)
    if sslmode and "ssl" not in query:
        query["ssl"] = sslmode
    return url.set(query=query).render_as_string(hide_password=False)


database_url = os.getenv("DATABASE_URL")
if not database_url:
    raise RuntimeError("DATABASE_URL is not set. Add it to .env or the environment.")


engine = create_async_engine(
    _async_database_url(database_url),
    pool_pre_ping=True,
)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_db_session() -> AsyncGenerator[AsyncSession, None]:
    """Provide a transaction-ready database session to a FastAPI route."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def verify_database_connection() -> None:
    """Raise an exception if a connection cannot be established."""
    async with engine.connect() as connection:
        await connection.execute(text("SELECT 1"))
