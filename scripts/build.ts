import { mkdir } from 'node:fs/promises';

import solidPlugin from '@opentui/solid/bun-plugin';

/**
 * Compiles margarita into one self-contained `marg` executable (Bun runtime, the
 * Solid transform and OpenTUI's native library embedded). Usage:
 *   bun run build               # current platform → dist/marg[.exe]
 *   bun run build <bun-target>  # e.g. bun-linux-x64, bun-darwin-arm64
 */
const target = process.argv[2];
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
    ...(target === undefined ? {} : { target: target as Bun.Build.CompileTarget }),
  },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${outfile}`);
