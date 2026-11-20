import type { TextRenderable } from '@opentui/core';
import { useRenderer } from '@opentui/solid';
import type { Accessor } from 'solid-js';
import { createEffect, For, onCleanup, Show } from 'solid-js';

import type { Completion, Notice } from '../app/app-state.ts';
import type { AppController } from '../app/controller.ts';
import { attachmentLabel } from '../domain/attachment.ts';
import { caretCell } from '../domain/caret-position.ts';
import { contextSeverity } from '../domain/context-occupancy.ts';
import { type FooterFacts, type FooterSegment, footerSegments } from '../domain/footer.ts';
import { goalBadge } from '../domain/native-goal.ts';
import { directoryName } from '../domain/path-identity.ts';
import { executionLabel } from '../domain/session.ts';
import { agentColor } from './agent-color.ts';
import type { Theme } from './theme.ts';

/** Prompt rule, composer and completion list. The caret is the terminal's real cursor. */
export function ComposerView(props: { controller: AppController; theme: Theme; width: number }) {
  const state = props.controller.state;
  const renderer = useRenderer();
  let composerText: TextRenderable | undefined;
  const active = () => state.route.kind !== 'overview' || state.overview.focus === 'composer';
  const placeholder = () =>
    state.route.kind === 'overview'
      ? `New session in ${directoryName(state.overview.project.directory)}`
      : state.route.kind === 'new'
        ? `New session in ${directoryName(state.route.directory)} · ← overview`
        : '← overview · Shift+Tab agent · Ctrl+O details';
  const rule = () => '─'.repeat(Math.max(0, props.width));

  createEffect(() => {
    if (!active() || state.overlay.kind !== 'none' || composerText === undefined) {
      renderer.setCursorPosition(0, 0, false);
      return;
    }
    renderer.setCursorStyle({ style: 'line', blinking: true });
    const { row, col } = caretCell(
      state.composer.text,
      state.composer.cursor,
      Math.max(1, props.width - 2),
    );
    renderer.setCursorPosition(composerText.x + 2 + col, composerText.y + row, true);
  });
  onCleanup(() => renderer.setCursorPosition(0, 0, false));

  return (
    <box flexDirection="column" flexShrink={0}>
      <Show when={state.attachments.length > 0}>
        <box flexDirection="row" paddingLeft={1}>
          <text fg={props.theme.accentLight}>
            {`⌫ ${state.attachments.map((attachment) => attachmentLabel(attachment)).join('   ·   ')}`}
          </text>
        </box>
      </Show>
      <text fg={props.theme.border}>{rule()}</text>
      <box flexDirection="row">
        <text fg={active() ? props.theme.text : props.theme.dim}>❯ </text>
        <text
          ref={(element: TextRenderable) => {
            composerText = element;
          }}
          fg={
            state.composer.text === ''
              ? props.theme.dim
              : active()
                ? props.theme.text
                : props.theme.dim
          }
        >
          {state.composer.text === '' ? placeholder() : state.composer.text}
        </text>
      </box>
      <text fg={props.theme.border}>{rule()}</text>
      <Show when={state.completion}>
        {(completion: Accessor<Completion>) => (
          <box flexDirection="column">
            <For each={completion().items.slice(0, 8)}>
              {(item, index) => (
                <text fg={index() === completion().index ? props.theme.accent : props.theme.dim}>
                  {`  ${item.label}  `}
                  <span style={{ fg: props.theme.dim }}>{item.detail}</span>
                </text>
              )}
            </For>
          </box>
        )}
      </Show>
    </box>
  );
}

/** The only persistent chrome: one line under the composer (docs/13). */
export function Footer(props: { controller: AppController; theme: Theme; width: number }) {
  const state = props.controller.state;
  const facts = (): FooterFacts => {
    // One server-qualified view; never reconstruct identity from a bare session id (#78).
    const view = props.controller.currentView();
    if (view === undefined) {
      return {
        ...(state.overview.agent === undefined ? {} : { agent: state.overview.agent }),
        ...(state.overview.model === undefined ? {} : { model: state.overview.model }),
        state: state.stream === 'live' ? 'overview' : state.stream,
        queued: 0,
        stale: false,
      };
    }
    const session = view.session;
    const badge = goalBadge(view.nativeGoal, view.awaitingSteer);
    return {
      ...(session?.agent === undefined ? {} : { agent: session.agent }),
      ...(session?.model === undefined ? {} : { model: session.model }),
      state: executionLabel(view.execution),
      ...(session?.tokens === undefined ? {} : { tokens: session.tokens }),
      ...(session?.cost === undefined ? {} : { cost: session.cost }),
      queued: view.queued.length,
      stale: view.stream !== 'live',
      ...(badge === '' ? {} : { goal: badge }),
    };
  };
  const segments = () => footerSegments(facts(), props.width - 2);
  const segmentColor = (segment: FooterSegment): string => {
    if (segment.kind === 'agent') return agentColor(facts().agent, props.theme);
    if (segment.kind === 'context') {
      const severity = contextSeverity(facts().contextOccupancy);
      return severity === 'critical'
        ? props.theme.error
        : severity === 'warning'
          ? props.theme.warn
          : severity === 'normal'
            ? props.theme.success
            : props.theme.dim;
    }
    return props.theme.dim;
  };
  const notice = () => state.notice;
  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1}>
      <Show when={notice()}>
        {(current: Accessor<Notice>) => (
          <text
            fg={
              current().tone === 'error'
                ? props.theme.error
                : current().tone === 'warn'
                  ? props.theme.warn
                  : props.theme.dim
            }
          >
            {current().text}
          </text>
        )}
      </Show>
      <text fg={props.theme.dim}>
        <For each={segments()}>
          {(segment) => <span style={{ fg: segmentColor(segment) }}>{segment.text}</span>}
        </For>
      </text>
    </box>
  );
}
