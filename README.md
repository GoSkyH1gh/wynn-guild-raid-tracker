# Guild Raid Tracker
A relatively simple tracker which uses the wynn api to show how many graids a guild's members have done to payout rewards

Also includes Discord oauth, and tracks which rewards have been paid out and which are pending.

If you want to host it yourself, you'll need a postgres database with a connection string, a wynn token, a discord app, and a few other things (look at .env.example).

To run locally:
```
uv sync
uv run fastapi dev
```
```
npm install
npm run dev
```

By default, all users are untrusted and get access by being added through the api with a secret or through the env variables.

If oauth doesn't work, check that the redirect url is properly set (*FRONTEND_URL* and *DISCORD_REDIRECT_URI*)