/**
 * Runs the writable integration suite (`test/writable/`) against a disposable OpenCode
 * service. Sets the opt-in flag itself so it works the same on every shell.
 */
const child = Bun.spawn(['bun', 'test', 'test/writable', ...Bun.argv.slice(2)], {
  stdout: 'inherit',
  stderr: 'inherit',
  env: { ...process.env, MARGARITA_LIVE_WRITE: '1' },
});
process.exit(await child.exited);
