import type { Accessor } from 'solid-js';
import { createSignal, For, onCleanup, Show } from 'solid-js';

import type { Completion, Notice } from '../app/app-state.ts';
import type { AppController } from '../app/controller.ts';
import { attachmentLabel } from '../domain/attachment.ts';
import { caretPaint } from '../domain/composer.ts';
import { contextSeverity } from '../domain/context-occupancy.ts';
import {
  type FooterAction,
  type FooterFacts,
  type FooterSegment,
  footerSegments,
} from '../domain/footer.ts';
import { goalBadge } from '../domain/native-goal.ts';
import { directoryName } from '../domain/path-identity.ts';
import { executionLabel } from '../domain/session.ts';
import { agentColor } from './agent-color.ts';
import type { Theme } from './theme.ts';

/**
 * Prompt rule, composer and completion list.
 *
 * The caret is an in-cell style (underline) on the grapheme at the insertion boundary, not a
 * character inserted into the text. It deliberately does not use the terminal's hardware cursor:
 * OpenTUI owns that cursor and moves it during every frame paint, which left stray bars in
 * transcript rows and welcome panels (#130). A painted glyph shifted the suffix and changed
 * wrapping by one cell (#137); styling an existing grapheme keeps the layout identical in both
 * blink phases. The caret is always at the insertion point and can never leak outside this box.
 */
export function ComposerView(props: { controller: AppController; theme: Theme; width: number }) {
  const state = props.controller.state;
  const [blinkOn, setBlinkOn] = createSignal(true);
  const timer = setInterval(() => setBlinkOn((on) => !on), 530);
  onCleanup(() => clearInterval(timer));
  const active = () => state.route.kind !== 'overview' || state.overview.focus === 'composer';
  const ownsCaret = () => active() && state.overlay.kind === 'none';
  // The caret marks an existing grapheme's cell; the text itself is never changed (#137).
  const paint = () => caretPaint(state.composer, ownsCaret() && blinkOn());
  const empty = () => state.composer.text === '';
  const placeholder = () =>
    state.route.kind === 'overview'
      ? `New session in ${directoryName(state.overview.project.directory)}`
      : state.route.kind === 'new'
        ? `New session in ${directoryName(state.route.directory)} · ← overview`
        : '← overview · Shift+Tab agent · Ctrl+O details';
  const rule = () => '─'.repeat(Math.max(0, props.width));

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
        <text fg={empty() || !active() ? props.theme.dim : props.theme.text}>
          {paint().before}
          <Show when={paint().marked !== ''}>
            <span style={{ underline: true, fg: props.theme.accentLight }}>{paint().marked}</span>
          </Show>
          {empty() ? placeholder() : paint().after}
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
      const project = state.overview.project;
      const newModel = props.controller.modelFor(project.serverID, project.directory);
      return {
        ...(state.overview.agent === undefined ? {} : { agent: state.overview.agent }),
        ...(newModel.model === undefined ? {} : { model: newModel.model }),
        ...(newModel.status === undefined ? {} : { modelStatus: newModel.status }),
        state: state.stream === 'live' ? 'overview' : state.stream,
        queued: 0,
        stale: false,
      };
    }
    const session = view.session;
    const sessionModel =
      session?.model !== undefined || session === undefined
        ? {}
        : props.controller.modelFor(session.serverID, session.directory, true);
    const badge = goalBadge(view.nativeGoal, view.awaitingSteer);
    // The context meter is the latest step's occupancy, never cumulative session tokens.
    // While a compaction is pending there is no confirmed reading, so show no meter.
    const context = props.controller.usageAnalytics().context;
    return {
      ...(session?.agent === undefined ? {} : { agent: session.agent }),
      ...(session?.model === undefined ? {} : { model: session.model }),
      ...(sessionModel.model === undefined ? {} : { model: sessionModel.model }),
      ...(sessionModel.status === undefined ? {} : { modelStatus: sessionModel.status }),
      state: executionLabel(view.execution),
      ...(session?.tokens === undefined ? {} : { tokens: session.tokens }),
      ...(session?.cost === undefined ? {} : { cost: session.cost }),
      queued: view.queued.length,
      stale: view.stream !== 'live',
      ...(badge === '' ? {} : { goal: badge }),
      ...(context.status !== 'known'
        ? {}
        : {
            ...(context.occupancy === undefined ? {} : { contextOccupancy: context.occupancy }),
            ...(context.tokens === undefined ? {} : { contextTokens: context.tokens }),
          }),
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
      <box flexDirection="row">
        <For each={segments()}>
          {(segment) => {
            const action: FooterAction | undefined = segment.action;
            return (
              <text
                fg={segmentColor(segment)}
                {...(action === undefined
                  ? {}
                  : { onMouseDown: () => props.controller.activateFooter(action) })}
              >
                {segment.text}
              </text>
            );
          }}
        </For>
      </box>
    </box>
  );
}
