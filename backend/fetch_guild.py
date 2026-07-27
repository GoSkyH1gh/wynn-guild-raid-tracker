from httpx import AsyncClient
import httpx
from dotenv import load_dotenv
import os
import asyncio
from pydantic import BaseModel
import time

load_dotenv()


class GuildMember(BaseModel):
    username: str
    current_guild_raids: int | None
    current_notg: int | None
    current_nol: int | None
    current_tcc: int | None
    current_tna: int | None
    current_wtp: int | None
    current_timestamp: float


BASE_WYNN_URL = "https://api.wynncraft.com/v3/guild/uuid/"
WYNN_TOKEN = os.getenv("WYNN_TOKEN")
GUILD_UUID = os.getenv("GUILD_UUID")

AUTH_HEADER = {"Authorization": f"Bearer {WYNN_TOKEN}"}

GUILD_RANKS = ["owner", "chief", "strategist", "captain", "recruiter", "recruit"]


async def fetch_guild_stats():
    client = AsyncClient()
    try:
        response = await client.get(f"{BASE_WYNN_URL}{GUILD_UUID}", headers=AUTH_HEADER)
        response.raise_for_status()
    except httpx.RequestError:
        print("something went wrong")

    data = response.json()

    # print(data)
    members: list[GuildMember] = []

    for rank in GUILD_RANKS:
        rank_members = data["members"][rank]
        print(rank_members)

        for member in rank_members.items():
            username = member[0]
            member_data = member[1].get("globalData", {}).get("currentGuildRaids", {})
            member_raids = member_data.get("list", {})

            new_member = GuildMember(
                username=username,
                current_guild_raids=member_data.get("total"),
                current_notg=member_raids.get("Nest of the Grootslangs"),
                current_nol=member_raids.get("Orphion's Nexus of Light"),
                current_tcc=member_raids.get("The Canyon Colossus"),
                current_tna=member_raids.get("The Nameless Anomaly"),
                current_wtp=member_raids.get("The Wartorn Palace"),
                current_timestamp=time.time(),
            )

            members.append(new_member)

    print(members)




if __name__ == "__main__":
    data = asyncio.run(fetch_guild_stats())
