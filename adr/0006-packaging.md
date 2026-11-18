# ADR-0006 — Ship a Bun-compiled single executable

**Status:** accepted (milestone 5).

**Decision:** the release artifact is `marg`, built by `bun run build` (`bun build --compile` with the OpenTUI Solid plugin). The Bun runtime, all JavaScript and OpenTUI's native library are embedded, so users need neither Bun nor Node. Per-target builds: `bun run build bun-windows-x64`, `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64`, `bun-darwin-x64`. `bun link` stays available for contributors running from source.

**Rejected:** an npm package as the primary channel. It needs a matching Bun on the user's machine (OpenTUI uses Bun FFI, so Node cannot run it) and native-library resolution per platform, which is exactly what the compiled binary removes.

**Verified on Bun 1.4.4 / Windows 11:**

- The binary starts from any directory, including inside this repository. `autoloadBunfig: false` and `autoloadDotenv: false` are required: without them a compiled binary reads the *current directory's* `bunfig.toml` preload and `.env`, which broke startup and is a needless trust boundary.
- The native `opentui` library is embedded through a file import and extracted by the runtime; no files are written next to the binary.
- Binary size is about 126 MB on Windows x64 (Bun runtime dominates). Acceptable for a developer tool; revisit if Bun ships a slimmer runtime.

**Consequences:** releases are one file per target plus a SHA-256 checksum. Updating is replacing the file. Config and state stay in margarita's own app-data directories (see README), never OpenCode's.
