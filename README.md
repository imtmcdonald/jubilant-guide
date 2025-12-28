# jubilant-guide

A collection of small apps and experiments I’m building with the help of AI. Each app lives in its own folder and is intended to be runnable, readable, and easy to explore.

## Apps

| App | What it is | Tech |
| --- | --- | --- |
| [`chowsr`](./chowsr) | Full-stack web app with a separate API and UI | Vite + React, Express, SQLite |

## Getting started

1. Pick an app from the table above.
2. Open that app’s `README.md` for setup and run instructions.

## Working with AI

See `docs/ai.md` for prompting, verification, and “no secrets” guidelines.

## Notes

- This repo is a personal showcase and is not accepting external pull requests (see `CONTRIBUTING.md`).
- Please follow `SECURITY.md` for vulnerability reports.

## Repo conventions

- App-specific setup lives alongside the app (look for `.env.example`, `Dockerfile`, and `README.md`).
- Avoid committing secrets: prefer `.env.example` and keep real values in `.env` (gitignored per app).
