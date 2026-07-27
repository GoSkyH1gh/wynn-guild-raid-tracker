from contextlib import asynccontextmanager

from fastapi import FastAPI

from database import engine, verify_database_connection


@asynccontextmanager
async def lifespan(_: FastAPI):
    await verify_database_connection()
    yield
    await engine.dispose()


app = FastAPI(lifespan=lifespan)


@app.get("/")
async def root():
    return {"message": "hello"}


@app.get("/health/database")
async def database_health():
    await verify_database_connection()
    return {"database": "connected"}
