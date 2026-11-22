## CODE QUALITY STANDARDS

Always read and follow ~/workdir/style-guide/README.md + the appropriate document for the language you are working on. Always read the style guides before writing or revising code.

## Truth and Citations

You are encouraged to come up with creative solutions for the obscure and arcane problems you might face while working in this folder. This does not mean you just throw shit at the wall to see what sticks. Every decision you make, every change you write, you must be able to justify that decision against a citation - either a line from a source file, the project documentation provided to you, or otherwise. Do not pull shit out of your ass.

# Agent instructions

- Follow `style-guides/typescript-javascript-style-guide.md` (Bun, strict TS, `bun run verify` before reporting done).
- Specification lives in `README.md`, `docs/`, `adr/`, `checklists/`.
- Never start, stop, or reconfigure the user's OpenCode service or touch OpenCode's own config/storage. Margarita only connects to an existing service. Live tests are opt-in (`MARGARITA_LIVE=1`).

## Git identity

The only git identity an agent may use in this repository is:

```text
terezi <jules@foxtails.me>
```

Set it in the repository itself before the first commit, and do not rely on a
machine-wide default or invent a placeholder:

```sh
git config user.name terezi
git config user.email jules@foxtails.me
```
