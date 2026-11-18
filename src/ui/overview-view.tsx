import type { Accessor } from 'solid-js';
import { For, Match, Show, Switch } from 'solid-js';

import type { AppController } from '../app/controller.ts';
import { groupRows, loadMoreRowKey, type OverviewRow } from '../domain/overview-groups.ts';
import { directoryName } from '../domain/path-identity.ts';
import type { SessionSummary } from '../domain/session.ts';
import { executionLabel } from '../domain/session.ts';
import { formatAge } from '../domain/usage-format.ts';
import type { Theme } from './theme.ts';

type RowOf<K extends OverviewRow['kind']> = Extract<OverviewRow, { kind: K }>;

/**
 * Project-grouped session list (docs/04), most recently used first. Each project shows
 * six sessions; the rest expand inline behind a Show more/less row. Rows never animate.
 */
export function Overview(props: { controller: AppController; theme: Theme; now: number }) {
  const state = props.controller.state;
  const groups = () => props.controller.groups();
  const selected = (key: string) =>
    state.overview.focus === 'list' && state.overview.selectedRow === key;
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
            <For each={groupRows(group, state.overview.expanded[group.key] === true)}>
              {(row) => (
                <Switch>
                  <Match when={row.kind === 'session' ? row : undefined}>
                    {(sessionRow: Accessor<RowOf<'session'>>) => (
                      <SessionLine
                        controller={props.controller}
                        theme={props.theme}
                        now={props.now}
                        session={sessionRow().session}
                        selected={selected(row.key)}
                      />
                    )}
                  </Match>
                  <Match when={row.kind === 'toggle' ? row : undefined}>
                    {(toggle: Accessor<RowOf<'toggle'>>) => (
                      <text fg={selected(row.key) ? props.theme.accent : props.theme.dim}>
                        {`${selected(row.key) ? '  ❯ ' : '    '}${
                          toggle().expanded ? '[Show less]' : `[Show more] ${toggle().hidden}`
                        }`}
                      </text>
                    )}
                  </Match>
                </Switch>
              )}
            </For>
          </box>
        )}
      </For>
      <Show when={!state.sessionsComplete}>
        <text fg={props.theme.dim}>Showing recent sessions only.</text>
        <text fg={selected(loadMoreRowKey) ? props.theme.accent : props.theme.dim}>
          {`${selected(loadMoreRowKey) ? '  ❯ ' : '    '}${
            state.sessionsLoading
              ? '[Loading more sessions…]'
              : state.sessionsError !== undefined
                ? '[Retry loading sessions]'
                : '[Load more sessions]'
          }`}
        </text>
        <Show when={state.sessionsError !== undefined}>
          <text
            fg={props.theme.warn}
          >{`Could not load more sessions: ${state.sessionsError}`}</text>
        </Show>
      </Show>
      <Show when={state.sessionsComplete && groups().length > 0}>
        <text fg={props.theme.dim}>All sessions loaded.</text>
      </Show>
      <text fg={props.theme.dim} marginTop={1}>
        {`New session in: ${directoryName(state.overview.directory)}`}
      </text>
    </scrollbox>
  );
}

function SessionLine(props: {
  controller: AppController;
  theme: Theme;
  now: number;
  session: SessionSummary;
  selected: boolean;
}) {
  const execution = () => props.controller.executionOf(props.session.id);
  const tasks = () => {
    const count = props.controller.planProgress(props.session.id);
    return count === undefined ? '' : ` · ${count.done}/${count.total} tasks`;
  };
  const status = () =>
    `${executionLabel(execution())}${tasks()} · ${formatAge(props.controller.lastUsed(props.session), props.now)}`;
  const attention = () =>
    execution().state === 'waiting' ||
    (execution().state === 'idle' && props.session.outcome === 'failed');
  return (
    <box flexDirection="row">
      <text fg={props.selected ? props.theme.accent : props.theme.dim}>
        {props.selected ? '  ❯ ' : '    '}
      </text>
      <text flexGrow={1} fg={props.theme.text}>
        {props.session.title ?? props.session.id}
      </text>
      <text fg={attention() ? props.theme.warn : props.theme.dim}>{` ${status()}`}</text>
    </box>
  );
}
