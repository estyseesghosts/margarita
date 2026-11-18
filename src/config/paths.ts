import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Margarita's own directories. They never overlap OpenCode's config or state.
 * Windows: %LOCALAPPDATA%\margarita; elsewhere XDG config/state homes.
 */
export type AppPaths = Readonly<{ configFile: string; stateFile: string; stateDir: string }>;

export function appPaths(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): AppPaths {
  if (platform === 'win32') {
    const base = env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
    const dir = join(base, 'margarita');
    return {
      configFile: join(dir, 'config.jsonc'),
      stateFile: join(dir, 'state.json'),
      stateDir: dir,
    };
  }
  const configHome = env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config');
  const stateHome = env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state');
  const stateDir = join(stateHome, 'margarita');
  return {
    configFile: join(configHome, 'margarita', 'config.jsonc'),
    stateFile: join(stateDir, 'state.json'),
    stateDir,
  };
}
