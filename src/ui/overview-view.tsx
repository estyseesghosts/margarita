import { For, Show } from 'solid-js';

import type { AppController } from '../app/controller.ts';
import { directoryName } from '../domain/path-identity.ts';
import { executionLabel } from '../domain/session.ts';
import { formatAge } from '../domain/usage-format.ts';
import type { Theme } from './theme.ts';

/** Project-grouped session list (docs/04). Rows never animate; status is a word. */
export function Overview(props: { controller: AppController; theme: Theme; now: number }) {
  const state = props.controller.state;
  const groups = () => props.controller.groups();
  return (
    <scrollbox flexGrow={1} paddingLeft={1} paddingRight={1}>
      <text fg={props.theme.text} marginBottom={1}>
        <b>Sessions</b>
      </text>
      <Show when={groups().length === 0}>
        <text fg={props.theme.dim}>No sessions yet. Type below to start one.</text>
      </Show>
      <For each={groups()}>
        {(group) => (
          <box flexDirection="column" marginBottom={1}>
            <text>
              <span style={{ fg: props.theme.text }}>
                <b>{group.name}</b>
              </span>
              <span style={{ fg: props.theme.dim }}>{`  ${group.directory}`}</span>
            </text>
            <For each={group.sessions}>
              {(session) => {
                const selected = () =>
                  state.overview.focus === 'list' &&
                  state.overview.selectedSessionID === session.id;
                const execution = () => props.controller.executionOf(session.id);
                const status = () =>
                  `${executionLabel(execution())} · ${formatAge(session.updatedAt, props.now)}`;
                const attention = () =>
                  execution().state === 'waiting' ||
                  (execution().state === 'idle' && session.outcome === 'failed');
                return (
                  <box flexDirection="row">
                    <text fg={selected() ? props.theme.accent : props.theme.dim}>
                      {selected() ? '  ❯ ' : '    '}
                    </text>
                    <text flexGrow={1} fg={selected() ? props.theme.text : props.theme.text}>
                      {session.title ?? session.id}
                    </text>
                    <text
                      fg={attention() ? props.theme.warn : props.theme.dim}
                    >{` ${status()}`}</text>
                  </box>
                );
              }}
            </For>
          </box>
        )}
      </For>
      <Show when={!state.sessionsComplete && groups().length > 0}>
        <text fg={props.theme.dim}>Showing recent sessions only.</text>
      </Show>
      <text fg={props.theme.dim} marginTop={1}>
        {`New session in: ${directoryName(state.overview.directory)}`}
      </text>
    </scrollbox>
  );
}
