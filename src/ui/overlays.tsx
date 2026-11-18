import type { Accessor } from 'solid-js';
import { For, Match, Show, Switch } from 'solid-js';

import type { Overlay } from '../app/app-state.ts';
import type { AppController } from '../app/controller.ts';
import { actionIDs, formatBinding, type Keymap } from '../domain/keymap.ts';
import { formatModelRef } from '../domain/model-ref.ts';
import type { SessionSummary, TokenUsage } from '../domain/session.ts';
import { localCommands } from '../domain/slash-command.ts';
import { formatCost, formatTokenCount } from '../domain/usage-format.ts';
import type { Theme } from './theme.ts';

const visibleRows = 10;

/** Focused dialogs drawn above the composer. They are overlays, never routes. */
export function OverlayView(props: { controller: AppController; keymap: Keymap; theme: Theme }) {
  const state = props.controller.state;
  const frame = (title: string) => ({
    border: true,
    borderStyle: 'rounded' as const,
    borderColor: props.theme.border,
    title: ` ${title} `,
    flexDirection: 'column' as const,
    paddingLeft: 1,
    paddingRight: 1,
    flexShrink: 0,
  });
  const dim = () => props.theme.dim;

  return (
    <Switch>
      <Match when={state.overlay.kind === 'help'}>
        <box {...frame('Keys · Esc to close')}>
          <For each={actionIDs}>
            {(action) => {
              const binding = props.keymap.get(action);
              return (
                <text fg={props.theme.text}>
                  {(binding === undefined ? 'unbound' : formatBinding(binding)).padEnd(16)}
                  <span style={{ fg: dim() }}>{action}</span>
                </text>
              );
            }}
          </For>
          <text fg={props.theme.text}>
            {'Left'.padEnd(16)}
            <span style={{ fg: dim() }}>overview (empty prompt only)</span>
          </text>
          <text fg={props.theme.text}>
            {'Ctrl+C'.padEnd(16)}
            <span style={{ fg: dim() }}>interrupt · clear · exit</span>
          </text>
          <text fg={dim()} marginTop={1}>
            {Object.keys(localCommands)
              .map((name) => `/${name}`)
              .join(' ')}
          </text>
        </box>
      </Match>
      <Match when={state.overlay.kind === 'usage'}>
        <box {...frame('Usage · server-reported')}>
          <Show
            when={props.controller.currentSession()}
            fallback={<text fg={dim()}>Open a session to see its usage.</text>}
          >
            {(session: Accessor<SessionSummary>) => (
              <>
                <text fg={props.theme.text}>{`Session spend  ${formatCost(session().cost)}`}</text>
                <Show
                  when={session().tokens}
                  fallback={<text fg={dim()}>Token usage not reported.</text>}
                >
                  {(tokens: Accessor<TokenUsage>) => (
                    <>
                      <text
                        fg={props.theme.text}
                      >{`Input          ${formatTokenCount(tokens().input)}`}</text>
                      <text
                        fg={props.theme.text}
                      >{`Output         ${formatTokenCount(tokens().output)}`}</text>
                      <text
                        fg={props.theme.text}
                      >{`Reasoning      ${formatTokenCount(tokens().reasoning)}`}</text>
                      <text
                        fg={props.theme.text}
                      >{`Cache read     ${formatTokenCount(tokens().cacheRead)}`}</text>
                      <text
                        fg={props.theme.text}
                      >{`Cache write    ${formatTokenCount(tokens().cacheWrite)}`}</text>
                    </>
                  )}
                </Show>
                <text
                  fg={dim()}
                >{`Model  ${props.controller.describeModel(session().model)}`}</text>
              </>
            )}
          </Show>
        </box>
      </Match>
      <Match when={state.overlay.kind === 'status'}>
        <box {...frame('Status')}>
          <text fg={props.theme.text}>{`Server  ${props.controller.serverUrl}`}</text>
          <text fg={props.theme.text}>{`Stream  ${state.stream}`}</text>
          <text fg={props.theme.text}>{`Project ${props.controller.currentDirectory()}`}</text>
          <Show when={props.controller.currentSession()}>
            {(session: Accessor<SessionSummary>) => (
              <text fg={props.theme.text}>{`Session ${session().id}`}</text>
            )}
          </Show>
          <text fg={dim()}>{`margarita v${props.controller.version}`}</text>
        </box>
      </Match>
      <Match when={state.overlay.kind === 'queue' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'queue' }>>) => {
          return (
            <box {...frame('Queue · ↑↓ select · x cancel · s steer · Esc close')}>
              <Show
                when={queuedItems(props.controller).length > 0}
                fallback={<text fg={dim()}>Nothing queued.</text>}
              >
                <For each={queuedItems(props.controller)}>
                  {(item, index) => (
                    <text fg={index() === overlay().index ? props.theme.accent : props.theme.text}>
                      {`${index() === overlay().index ? '❯' : ' '} [${item.delivery}] ${item.text.split('\n')[0] ?? ''}`}
                    </text>
                  )}
                </For>
              </Show>
            </box>
          );
        }}
      </Match>
      <Match when={state.overlay.kind === 'model-picker' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'model-picker' }>>) => {
          const choices = () => props.controller.modelChoices(overlay().query);
          const start = () => Math.max(0, overlay().index - visibleRows + 1);
          return (
            <box {...frame('Model · type to filter · Enter select')}>
              <text fg={props.theme.text}>{`> ${overlay().query}`}</text>
              <Show
                when={choices().length > 0}
                fallback={<text fg={dim()}>No matching models.</text>}
              >
                <For each={choices().slice(start(), start() + visibleRows)}>
                  {(choice, index) => {
                    const selected = () => start() + index() === overlay().index;
                    return (
                      <text fg={selected() ? props.theme.accent : props.theme.text}>
                        {`${selected() ? '❯' : ' '} ${formatModelRef(choice)}`}
                      </text>
                    );
                  }}
                </For>
              </Show>
            </box>
          );
        }}
      </Match>
      <Match when={state.overlay.kind === 'history-search' ? state.overlay : undefined}>
        {(overlay: Accessor<Extract<Overlay, { kind: 'history-search' }>>) => (
          <box {...frame('History search · Ctrl+R older · Enter use')}>
            <text fg={props.theme.text}>{`> ${overlay().query}`}</text>
            <text fg={dim()}>{props.controller.historySearchMatch() ?? 'no match'}</text>
          </box>
        )}
      </Match>
    </Switch>
  );
}

function queuedItems(controller: AppController) {
  const session = controller.currentSession();
  return session === undefined ? [] : (controller.state.inbox[session.id] ?? []);
}
