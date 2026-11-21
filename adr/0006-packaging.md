# ADR-0006 — Ship a Bun-compiled single executable

**Status:** accepted (milestone 5).

**Decision:** the release artifact is `marg`, built by `bun run build` (`bun build --compile` with the OpenTUI Solid plugin). The Bun runtime, all JavaScript and OpenTUI's native library are embedded, so users need neither Bun nor Node. Per-target builds: `bun run build bun-windows-x64`, `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64`, `bun-darwin-x64`. `bun link` stays available for contributors running from source.

**Rejected:** an npm package as the primary channel. It needs a matching Bun on the user's machine (OpenTUI uses Bun FFI, so Node cannot run it) and native-library resolution per platform, which is exactly what the compiled binary removes.

**Verified on Bun 1.4.4 / Windows 11:**

- The binary starts from any directory, including inside this repository. `autoloadBunfig: false` and `autoloadDotenv: false` are required: without them a compiled binary reads the *current directory's* `bunfig.toml` preload and `.env`, which broke startup and is a needless trust boundary.
- The native `opentui` library is embedded through a file import and extracted by the runtime; no files are written next to the binary.
- Binary size is about 126 MB on Windows x64 (Bun runtime dominates). Acceptable for a developer tool; revisit if Bun ships a slimmer runtime.

**Consequences:** releases are one file per target plus a SHA-256 checksum. Updating is replacing the file. Config and state stay in margarita's own app-data directories (see README), never OpenCode's.

**Verified on Bun 1.4.4 / Fedora 44 (WSL2, x86_64, glibc) (#179):**

- Without help, `bun run build bun-linux-x64` fails with `Could not resolve: "@opentui/core-linux-x64-musl"`: OpenTUI chooses its Linux native package from `process.env.OPENTUI_LIBC` at run time, so the bundler follows both variants. `scripts/build.ts` now defines `process.env.OPENTUI_LIBC` at compile time (`musl` for `-musl` targets, `glibc` otherwise, Linux targets only), which embeds exactly one variant and leaves Windows untouched.
- The resulting `dist/marg` (about 126 MB) runs from an unrelated directory with no Bun or `node_modules`: `--version`, `--help` and an interactive PTY session (renderer paints, Ctrl+C exits 0, cursor/mouse/alternate-screen restored). The CI job `executable-linux` repeats this on every push.
- `ldd` lists only `libc`, `libm`, `libdl`, `libpthread` and the loader; the highest versioned glibc symbol imported by the binary was `GLIBC_2.17`. That is a property of this build, not a promise for every distribution: build on the oldest glibc you intend to support.
- Not verified: Ubuntu, ARM64 and musl targets (tracked separately), and real terminal emulators.
