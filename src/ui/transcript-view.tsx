import type { ScrollBoxRenderable } from '@opentui/core';
import type { Accessor } from 'solid-js';
import { createMemo, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js';

import type { PermissionPrompt } from '../adapter/backend.ts';
import type { AppController } from '../app/controller.ts';
import type { ScrollMove } from '../app/key-router.ts';
import { formatModelRef, type ModelSelection } from '../domain/model-ref.ts';
import { sanitizeTerminalText as sanitizeText } from '../domain/sanitize-text.ts';
import { assertNever } from '../domain/session.ts';
import type { ThrobberFacts } from '../domain/throbber.ts';
import { latestTurn } from '../domain/throbber.ts';
import {
  describeTool,
  foldTranscript,
  formatToolTiming,
  type ToolCall,
  type TranscriptNode,
  windowNodes,
} from '../domain/transcript.ts';
import type { Theme } from './theme.ts';
import { Throbber } from './throbber-view.tsx';

export type TranscriptProps = Readonly<{
  controller: AppController;
  sessionID: string;
  theme: Theme;
  width: number;
  animate: boolean;
  ascii: boolean;
  /** Receives the scroll function for key routing while this transcript is mounted. */
  onScrollHandle?: (scroll: ((move: ScrollMove) => void) | undefined) => void;
}>;

const outputPreviewLines = 12;

type NodeOf<K extends TranscriptNode['kind']> = Extract<TranscriptNode, { kind: K }>;

export function Transcript(props: TranscriptProps) {
  const state = props.controller.state;
  const transcript = () => state.transcripts[props.sessionID];
  const nodes = createMemo(() =>
    foldTranscript(transcript()?.messages ?? [], {
      detailed: state.detailed,
      expandedGroups: new Set(Object.keys(state.expandedGroups)),
    }),
  );
  const windowed = createMemo(() =>
    windowNodes(nodes(), props.controller.transcriptWindow(props.sessionID)),
  );
  let box: ScrollBoxRenderable | undefined;

  const scroll = (move: ScrollMove) => {
    if (box === undefined) return;
    const page = Math.max(1, box.height - 2);
    switch (move) {
      case 'pageUp': {
        if (box.scrollTop > 0) {
          box.scrollBy(-page);
          return;
        }
        // At the top: reveal earlier nodes while keeping the current first node in place.
        const first = windowed().visible[0];
        const keep = first === undefined ? undefined : box.findDescendantById(nodeID(first.key));
        if (!props.controller.revealEarlier(props.sessionID, windowed().hidden)) return;
        if (keep !== undefined) {
          const release = box.anchor(keep);
          setTimeout(release, 2000);
        }
        return;
      }
      case 'pageDown':
        box.scrollBy(page);
        return;
      case 'top':
        box.scrollTo(0);
        return;
      case 'bottom':
        box.scrollTo(box.scrollHeight);
        return;
      default:
        assertNever(move);
    }
  };
  onMount(() => props.onScrollHandle?.(scroll));
  onCleanup(() => props.onScrollHandle?.(undefined));

  const turn = createMemo(() =>
    latestTurn(transcript()?.messages ?? [], state.running[props.sessionID] === true),
  );

  return (
    <scrollbox
      ref={(element: ScrollBoxRenderable) => {
        box = element;
      }}
      flexGrow={1}
      stickyScroll
      stickyStart="bottom"
      viewportCulling
      paddingLeft={1}
      paddingRight={1}
    >
      <WelcomePanel
        controller={props.controller}
        theme={props.theme}
        width={props.width}
        agent={state.sessions[props.sessionID]?.agent}
        model={state.sessions[props.sessionID]?.model}
        directory={state.sessions[props.sessionID]?.directory}
      />
      <Show when={windowed().hidden > 0 || transcript()?.olderCursor !== undefined}>
        <text fg={props.theme.dim}>
          {transcript()?.loading === true
            ? ' … loading earlier messages'
            : ' … earlier messages · PageUp at the top to show them'}
        </text>
      </Show>
      <Show when={transcript()?.loading === true && nodes().length === 0}>
        <text fg={props.theme.dim}> Loading conversation…</text>
      </Show>
      <For each={windowed().visible}>
        {(node) => (
          <box id={nodeID(node.key)} flexDirection="column" flexShrink={0}>
            <NodeView node={node} theme={props.theme} detailed={state.detailed} />
          </box>
        )}
      </For>
      <Show when={turn()}>
        {(facts: Accessor<ThrobberFacts>) => (
          <Throbber
            facts={facts()}
            width={props.width - 2}
            theme={props.theme}
            animate={props.animate}
            ascii={props.ascii}
          />
        )}
      </Show>
      <PermissionCard controller={props.controller} theme={props.theme} />
    </scrollbox>
  );
}

const cat = [' /\\_/\\ ', '( o.o )', ' > ^ < '];

export type WelcomeProps = Readonly<{
  controller: AppController;
  theme: Theme;
  width: number;
  agent: string | undefined;
  model: ModelSelection | undefined;
  directory: string | undefined;
}>;

/** Inline welcome panel; it scrolls away with the conversation (docs/13). */
export function WelcomePanel(props: WelcomeProps) {
  const model = () =>
    props.model === undefined ? 'server default model' : formatModelRef(props.model);
  const wide = () => props.width >= 70;
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={props.theme.border}
      title={` margarita v${props.controller.version} `}
      flexDirection="row"
      paddingLeft={1}
      paddingRight={1}
      marginBottom={1}
      flexShrink={0}
    >
      <box flexDirection="column" marginRight={2}>
        <For each={cat}>{(line) => <text fg={props.theme.accent}>{line}</text>}</For>
      </box>
      <box flexDirection="column" flexGrow={1}>
        <text fg={props.theme.text}>
          <b>Welcome back!</b>
        </text>
        <text fg={props.theme.dim}>{`${props.agent ?? 'build'} · ${model()}`}</text>
        <text fg={props.theme.dim}>{props.directory ?? props.controller.cwd}</text>
      </box>
      <Show when={wide()}>
        <box flexDirection="column" marginLeft={2}>
          <text fg={props.theme.dim}>← overview (empty prompt)</text>
          <text fg={props.theme.dim}>Shift+Tab agent · Alt+P model</text>
          <text fg={props.theme.dim}>Ctrl+O details · F1 help</text>
        </box>
      </Show>
    </box>
  );
}

function nodeID(key: string): string {
  return `node:${key}`;
}

function NodeView(props: { node: TranscriptNode; theme: Theme; detailed: boolean }) {
  const theme = () => props.theme;
  return (
    <Switch>
      <Match when={props.node.kind === 'user' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'user'>>) => (
          <box marginTop={1} backgroundColor={theme().userBg} flexDirection="row">
            <text fg={theme().dim}>❯ </text>
            <text fg={theme().user}>
              {sanitizeText(node().text)}
              {node().attachments.length > 0 ? `  [${node().attachments.join(', ')}]` : ''}
            </text>
          </box>
        )}
      </Match>
      <Match when={props.node.kind === 'text' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'text'>>) => (
          <box marginTop={1} flexDirection="row">
            <text fg={theme().text}>● </text>
            <text fg={theme().text}>{sanitizeText(node().text)}</text>
          </box>
        )}
      </Match>
      <Match when={props.node.kind === 'reasoning' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'reasoning'>>) => (
          <box marginTop={1} flexDirection="column" paddingLeft={2}>
            <text fg={theme().dim}>
              <i>{node().done ? '∴ Reasoning (model-provided)' : '∴ Thinking…'}</i>
            </text>
            <text fg={theme().dim}>{sanitizeText(node().text)}</text>
          </box>
        )}
      </Match>
      <Match when={props.node.kind === 'reasoning-unavailable' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'reasoning-unavailable'>>) => (
          <text
            fg={theme().dim}
          >{`  Reasoning text not available (${node().tokens} tokens reported)`}</text>
        )}
      </Match>
      <Match when={props.node.kind === 'tool' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'tool'>>) => (
          <ToolView
            tool={node().tool}
            expanded={node().expanded}
            detailed={props.detailed}
            theme={theme()}
          />
        )}
      </Match>
      <Match when={props.node.kind === 'tool-group' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'tool-group'>>) => (
          <box flexDirection="column" marginTop={1}>
            <text fg={theme().dim}>{`  ${node().summary}${node().running ? '…' : ''}`}</text>
            <Show when={node().expanded}>
              <For each={node().tools}>
                {(tool) => (
                  <ToolView tool={tool} expanded detailed={props.detailed} theme={theme()} />
                )}
              </For>
            </Show>
          </box>
        )}
      </Match>
      <Match when={props.node.kind === 'shell' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'shell'>>) => (
          <box flexDirection="column" marginTop={1}>
            <text fg={theme().text}>{`! ${sanitizeText(node().command)}`}</text>
            <text
              fg={
                node().exitCode !== undefined && node().exitCode !== 0 ? theme().error : theme().dim
              }
            >
              {`  └ ${node().status}${node().exitCode === undefined ? '' : ` (exit ${node().exitCode})`}`}
            </text>
            <Show when={node().output}>
              {(output: Accessor<string>) => <text fg={theme().dim}>{preview(output())}</text>}
            </Show>
          </box>
        )}
      </Match>
      <Match when={props.node.kind === 'notice' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'notice'>>) => (
          <text
            marginTop={1}
            fg={
              node().tone === 'error'
                ? theme().error
                : node().tone === 'warn'
                  ? theme().warn
                  : theme().dim
            }
          >
            {`  ${sanitizeText(node().text)}`}
          </text>
        )}
      </Match>
      <Match when={props.node.kind === 'meta' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'meta'>>) => <text fg={theme().dim}>{`  ${node().text}`}</text>}
      </Match>
    </Switch>
  );
}

function ToolView(props: { tool: ToolCall; expanded: boolean; detailed: boolean; theme: Theme }) {
  // Ctrl+O shows exact output (sanitized, untruncated) and timing.
  const render = (text: string) => (props.detailed ? full(text) : preview(text));
  const failed = () => props.tool.status === 'error';
  const bullet = () =>
    failed()
      ? props.theme.error
      : props.tool.status === 'completed'
        ? props.theme.success
        : props.theme.dim;
  return (
    <box flexDirection="column" marginTop={1}>
      <box flexDirection="row">
        <text fg={bullet()}>● </text>
        <text fg={props.theme.text}>{sanitizeText(describeTool(props.tool))}</text>
        <Show when={props.detailed}>
          <text fg={props.theme.dim}>{`  ${formatToolTiming(props.tool, clock)}`}</text>
        </Show>
      </box>
      {/* Failures are never hidden, even in compact mode. */}
      <Show when={props.tool.error}>
        {(error: Accessor<string>) => (
          <text fg={props.theme.error}>{`  └ ${render(error())}`}</text>
        )}
      </Show>
      <Show when={props.expanded && props.tool.output !== undefined && !failed()}>
        <text fg={props.theme.dim}>{`  └ ${render(props.tool.output ?? '')}`}</text>
      </Show>
    </box>
  );
}

function full(text: string): string {
  return sanitizeText(text).split('\n').join('\n    ');
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

function preview(text: string): string {
  const lines = sanitizeText(text).split('\n');
  if (lines.length <= outputPreviewLines) return lines.join('\n    ');
  const hidden = lines.length - outputPreviewLines;
  return [...lines.slice(0, outputPreviewLines), `… ${hidden} more lines (Ctrl+O)`].join('\n    ');
}

function PermissionCard(props: { controller: AppController; theme: Theme }) {
  const pending = () => props.controller.pendingPermission();
  return (
    <Show when={pending()}>
      {(request: Accessor<PermissionPrompt>) => (
        <box
          border
          borderStyle="rounded"
          borderColor={props.theme.warn}
          title=" Permission needed "
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          marginTop={1}
          flexShrink={0}
        >
          <text fg={props.theme.text}>
            <b>{sanitizeText(request().action)}</b>
          </text>
          <For each={request().resources}>
            {(resource) => <text fg={props.theme.dim}>{`  ${sanitizeText(resource)}`}</text>}
          </For>
          <Show when={request().message}>
            {(message: Accessor<string>) => (
              <text fg={props.theme.dim}>{sanitizeText(message())}</text>
            )}
          </Show>
          <text>
            <For each={props.controller.permissionChoices()}>
              {(choice, index) => (
                <span
                  style={{
                    fg:
                      index() === props.controller.state.permissionChoice
                        ? props.theme.accent
                        : props.theme.dim,
                  }}
                >
                  {index() === props.controller.state.permissionChoice
                    ? `[${label(choice)}]`
                    : ` ${label(choice)} `}
                  {'  '}
                </span>
              )}
            </For>
          </text>
          <text fg={props.theme.dim}>←/→ choose · Enter confirm · Esc reject</text>
        </box>
      )}
    </Show>
  );
}

function label(choice: string): string {
  return choice === 'once' ? 'Allow once' : choice === 'always' ? 'Always allow' : 'Reject';
}

/** A conversation not yet created on the server: welcome panel plus the prompt below. */
export function NewSessionView(props: {
  controller: AppController;
  directory: string;
  theme: Theme;
  width: number;
}) {
  const overview = () => props.controller.state.overview;
  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
      <WelcomePanel
        controller={props.controller}
        theme={props.theme}
        width={props.width}
        agent={overview().agent}
        model={overview().model}
        directory={props.directory}
      />
    </scrollbox>
  );
}
