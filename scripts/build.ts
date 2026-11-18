import { mkdir } from 'node:fs/promises';

import solidPlugin from '@opentui/solid/bun-plugin';

/**
 * Compiles margarita into one self-contained `marg` executable (Bun runtime, the
 * Solid transform and OpenTUI's native library embedded). Usage:
 *   bun run build               # current platform → dist/marg[.exe]
 *   bun run build <bun-target>  # e.g. bun-linux-x64, bun-darwin-arm64
 */
const requested = process.argv[2];
const target = requested === undefined ? undefined : asTarget(requested);
const windows = target === undefined ? process.platform === 'win32' : target.includes('windows');
const outfile = `dist/marg${windows ? '.exe' : ''}`;

await mkdir('dist', { recursive: true });
const result = await Bun.build({
  entrypoints: ['src/main.ts'],
  plugins: [solidPlugin],
  minify: true,
  sourcemap: 'linked',
  compile: {
    outfile,
    // Never pick up a bunfig.toml/.env from wherever marg is launched (e.g. this repo).
    autoloadBunfig: false,
    autoloadDotenv: false,
    ...(target === undefined ? {} : { target }),
  },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${outfile}`);

function asTarget(value: string): Bun.Build.CompileTarget {
  if (!isTarget(value)) {
    console.error(`unknown target ${value}; expected bun-<os>-<arch>[-modifier]`);
    process.exit(2);
  }
  return value;
}

function isTarget(value: string): value is Bun.Build.CompileTarget {
  return /^bun-(linux|darwin|windows)-(x64|arm64)(-(baseline|modern|musl))*$/.test(value);
}
