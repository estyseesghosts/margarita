# Agent instructions

- Follow `../typescript-style-guide.md` (Bun, strict TS, `bun run verify` before reporting done).
- Specification lives in `README.md`, `docs/`, `adr/`, `checklists/`.
- Never start, stop, or reconfigure the user's OpenCode service or touch OpenCode's own config/storage. Margarita only connects to an existing service. Live tests are opt-in (`MARGARITA_LIVE=1`).
