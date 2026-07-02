# Alpaca Investing Agent Rules

This repository is for preparing infrastructure for a future paper-first Alpaca investing platform.

## Safety Boundaries

- Do not connect to Alpaca from this repository unless the user explicitly requests it.
- Do not request, print, commit, or copy real Alpaca API keys.
- Do not configure live trading.
- Do not deploy autonomous trading logic.
- Do not expose application ports publicly except through an explicitly configured reverse proxy.
- Preserve key-based SSH access when changing server hardening.
- Treat `.env*`, `*.env`, `secrets/`, `.ssh/`, `.APILIVEKEY`, and `.APIPAPERKEY` as sensitive local material.

## Implementation Rules

- Inspect the repo before editing.
- Keep changes narrow and reversible.
- Prefer scripts and docs under `server/` for VPS provisioning work.
- Use paper-trading assumptions only.
- Validate shell scripts with `bash -n` after editing.
- Do not commit, deploy, push, or run VPS hardening unless the user explicitly asks.
