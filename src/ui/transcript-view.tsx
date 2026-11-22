import type { ScrollBoxRenderable, SyntaxStyle } from '@opentui/core';
import { getTreeSitterClient } from '@opentui/core';
import { useRenderer } from '@opentui/solid';
import type { Accessor } from 'solid-js';
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from 'solid-js';

import type { PermissionPrompt } from '../adapter/backend.ts';
import type { JobListStatus } from '../app/app-state.ts';
import type { AppController } from '../app/controller.ts';
import type { ScrollMove } from '../app/key-router.ts';
import type { PatchLine } from '../domain/diff.ts';
import { clampDiffPatch, diffCounts, editDiff, isEditLike, toolPath } from '../domain/edit-diff.ts';
import { type ExecutionMarker, executionMarkers } from '../domain/execution-segment.ts';
import { type FormRequest, initialVisibleFields } from '../domain/form.ts';
import { actionHint, type Keymap } from '../domain/keymap.ts';
import { formatModelRef, type ModelSelection } from '../domain/model-ref.ts';
import { sanitizeTerminalText as sanitizeText } from '../domain/sanitize-text.ts';
import { sessionKey } from '../domain/server-identity.ts';
import { assertNever } from '../domain/session.ts';
import { stickyPrompt, truncatePrompt } from '../domain/sticky-prompt.ts';
import { type ThrobberFacts } from '../domain/throbber.ts';
import {
  activeTool,
  attachBackgroundNotices,
  backgroundHint,
  boundedPreview,
  boundedTailPreview,
  describeTool,
  foldTranscript,
  formatToolTiming,
  type LiveTool,
  previewBudget,
  type PreviewKind,
  semanticPreview,
  type ToolCall,
  type ToolCallChild,
  toolIdentity,
  type TranscriptNode,
  windowNodes,
} from '../domain/transcript.ts';
import { workerNodes, type WorkerStatus, workerStatusLabel } from '../domain/worker.ts';
import { markerText } from './marker-text.ts';
import { QueuedPreview } from './queued-preview.tsx';
import { createSyntaxStyle } from './syntax.ts';
import type { Theme } from './theme.ts';
import { Throbber } from './throbber-view.tsx';

export type TranscriptProps = Readonly<{
  controller: AppController;
  keymap: Keymap;
  sessionID: string;
  serverID: string;
  theme: Theme;
  width: number;
  animate: boolean;
  ascii: boolean;
  /** How often the 10s background hint threshold is re-checked (default 1s). */
  hintTickMs?: number | undefined;
  /** Receives the scroll function for key routing while this transcript is mounted. */
  onScrollHandle?: (scroll: ((move: ScrollMove) => void) | undefined) => void;
}>;

type NodeOf<K extends TranscriptNode['kind']> = Extract<TranscriptNode, { kind: K }>;

/** One bounded warning for rows retained after a failed job refresh (#230). */
function jobWarning(
  worker: JobListStatus | undefined,
  shell: JobListStatus | undefined,
): string | undefined {
  const failed = [worker, shell].filter(
    (status): status is JobListStatus => status !== undefined && status.state !== 'confirmed',
  );
  if (failed.length === 0) return undefined;
  const retained = failed.some((status) => status.state === 'stale');
  const detail = failed.find((status) => status.detail !== undefined)?.detail ?? 'refresh failed';
  return retained
    ? `  background jobs may be out of date · ${detail}`
    : `  background job state unavailable · ${detail}`;
}

export function Transcript(props: TranscriptProps) {
  const state = props.controller.state;
  const backgroundKey = actionHint(props.keymap, 'tools.background');
  const sessionKeyValue = () =>
    sessionKey({ serverID: props.serverID, sessionID: props.sessionID });
  // The hint threshold is 10s, so a 2s tick keeps it accurate without transcript-speed
  // redraws, and the timer only asks while a call is actually running.
  const [hintNow, setHintNow] = createSignal(props.controller.now());
  const hintTimer = setInterval(() => {
    if (state.running[sessionKeyValue()] !== true) return;
    setHintNow(props.controller.now());
  }, props.hintTickMs ?? 1000);
  onCleanup(() => clearInterval(hintTimer));
  const transcript = () => state.transcripts[sessionKeyValue()];
  const mcpServers = () =>
    props.controller.mcpServersFor(
      props.serverID,
      state.sessions[sessionKeyValue()]?.directory ?? '',
    );
  const nodes = createMemo(() => {
    const messages = transcript()?.messages ?? [];
    const markers = new Map(
      executionMarkers(messages, state.running[sessionKeyValue()] === true).map((marker) => [
        marker.afterMessageId,
        marker,
      ]),
    );
    const expanded = props.controller.expandedSets();
    const folded = foldTranscript(messages, {
      detailed: state.detailed,
      expandedGroups: expanded.groups,
      expandedDiffs: expanded.diffs,
      mcpServers: mcpServers(),
      markers,
    });
    // A background confirmation is a transcript event, not a footer notice: inserting it
    // here keeps the composer anchored (#129). It is attached to the *exact* owning tool node
    // by tool ID, never to "the last tool-looking node": a later appended call cannot inherit
    // it, and a call outside this window simply shows no notice instead of a wrong one (#135).
    const background = state.backgrounded[sessionKeyValue()] ?? [];
    const withBackground: TranscriptNode[] =
      background.length > 0 && state.running[sessionKeyValue()] === true
        ? attachBackgroundNotices(folded, background)
        : folded;
    // Workers are server-confirmed rows (#101), appended after the turn so a still-running
    // parent stays visible above them. No client timer contributes to their status. A failed
    // refresh keeps the last confirmed rows and adds one bounded stale warning (#230).
    const key = sessionKeyValue();
    const warning = jobWarning(state.workerStatus[key], state.shellStatus[key]);
    return [
      ...withBackground,
      ...workerNodes(state.workers[key] ?? [], expanded.groups),
      ...(warning === undefined
        ? []
        : [{ kind: 'meta' as const, key: `job-status:${key}`, text: warning }]),
    ];
  });
  const windowed = createMemo(() =>
    windowNodes(nodes(), props.controller.transcriptWindow(props.sessionID, props.serverID)),
  );
  // Server-confirmed pending user follow-ups, FIFO (server order) — rendered in the
  // activity region right above the running task marker, never inside the composer.
  const queued = createMemo(() =>
    (state.inbox[sessionKeyValue()] ?? []).filter((item) => item.kind === 'user'),
  );
  const hasRunningMarker = createMemo(() =>
    nodes().some((node) => node.kind === 'execution' && node.segment.phase === 'running'),
  );
  let box: ScrollBoxRenderable | undefined;
  const renderer = useRenderer();
  const syntax = createMemo(() => createSyntaxStyle(props.theme, renderer.nativeScene));
  const [sticky, setSticky] = createSignal<string | undefined>(undefined);

  /** Recomputes which earlier prompt, if any, has scrolled out above the viewport. */
  const updateSticky = () => {
    if (box === undefined) return;
    const scrollbox = box;
    const positions = windowed().visible.flatMap((node) => {
      if (node.kind !== 'user') return [];
      const element = scrollbox.findDescendantById(nodeID(node.key));
      if (element === undefined) return [];
      // The wrapper starts with the prompt's top margin row.
      const top = element.y + 1 - scrollbox.y;
      return [
        { key: node.key, text: node.text, top, bottom: top + Math.max(1, element.height - 1) },
      ];
    });
    setSticky(stickyPrompt(positions)?.text);
  };
  createEffect(() => {
    windowed();
    box?.afterLayout(updateSticky);
  });

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
        if (!props.controller.revealEarlier(props.sessionID, windowed().hidden, props.serverID))
          return;
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
  onMount(() => {
    props.onScrollHandle?.(scroll);
    if (box !== undefined) box.verticalScrollBar.onChange = updateSticky;
  });
  onCleanup(() => props.onScrollHandle?.(undefined));

  const sessionModel = (): { model?: ModelSelection; status?: 'loading' | 'unavailable' } => {
    const session = state.sessions[sessionKeyValue()];
    if (session?.model !== undefined) return { model: session.model };
    return session === undefined
      ? {}
      : props.controller.modelFor(session.serverID, session.directory, true);
  };

  return (
    <box flexGrow={1} flexDirection="column">
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
          greeting={props.controller.greetingFor(
            `conversation:${props.serverID}:${props.sessionID}`,
          )}
          agent={props.controller.currentAgentID()}
          model={sessionModel().model}
          modelStatus={sessionModel().status}
          directory={state.sessions[sessionKeyValue()]?.directory}
        />
        <Show when={windowed().hidden > 0 || transcript()?.olderCursor !== undefined}>
          <text fg={props.theme.dim}>
            {transcript()?.loading === true
              ? ' … loading earlier messages'
              : transcript()?.olderCheckFailed === true
                ? ' … earlier history check failed · PageUp at the top to retry'
                : ' … earlier messages · PageUp at the top to show them'}
          </text>
        </Show>
        <Show when={transcript()?.loading === true && nodes().length === 0}>
          <text fg={props.theme.dim}> Loading conversation…</text>
        </Show>
        {/* Row slots persist by index: folding emits fresh node objects every update,
            and identity-keyed <For> would remount (and re-parse) every visible row on
            each streamed event. */}
        <Index each={windowed().visible}>
          {(node) => (
            <>
              <Show when={isRunningExecution(node()) && queued().length > 0}>
                <QueuedPreview items={queued()} theme={props.theme} width={props.width} />
              </Show>
              <box id={nodeID(node().key)} flexDirection="column" flexShrink={0}>
                <NodeView
                  node={node()}
                  theme={props.theme}
                  detailed={state.detailed}
                  syntax={syntax()}
                  width={props.width}
                  focused={isNodeFocused(node(), state.focusedGroup)}
                  animate={props.animate}
                  ascii={props.ascii}
                  mcpServers={mcpServers()}
                  now={hintNow()}
                  backgroundKey={backgroundKey}
                  backgroundShell={(shellID) =>
                    props.controller.shellRunningInBackground(
                      shellID,
                      props.sessionID,
                      props.serverID,
                    )
                  }
                  workerStale={
                    props.controller.workerJobStatus(props.sessionID, props.serverID)?.state ===
                    'stale'
                  }
                />
              </box>
            </>
          )}
        </Index>
        {/* Fallback: no running marker to sit above (e.g. transcript not loaded). */}
        <Show when={!hasRunningMarker() && queued().length > 0}>
          <QueuedPreview items={queued()} theme={props.theme} width={props.width} />
        </Show>
        <PermissionCard controller={props.controller} theme={props.theme} />
        <FormCard controller={props.controller} theme={props.theme} keymap={props.keymap} />
      </scrollbox>
      <Show when={sticky()}>
        {(text: Accessor<string>) => (
          <box
            position="absolute"
            top={0}
            left={0}
            right={0}
            height={1}
            backgroundColor={props.theme.userBg}
            flexDirection="row"
            paddingLeft={1}
          >
            <text fg={props.theme.dim}>❯ </text>
            <text fg={props.theme.user}>
              {truncatePrompt(sanitizeText(text()), props.width - 6)}
            </text>
          </box>
        )}
      </Show>
    </box>
  );
}

const cat = [' /\\_/\\ ', '( o.o )', ' > ^ < '];

const catWidth = 7;
const hintWidth = 34;

export type WelcomeProps = Readonly<{
  controller: AppController;
  theme: Theme;
  width: number;
  /** Chosen once by the caller for this route; never derived reactively from a clock. */
  greeting: string;
  agent: string | undefined;
  model: ModelSelection | undefined;
  /** Shown instead of a model while the scoped catalog loads or cannot provide one (#192). */
  modelStatus?: 'loading' | 'unavailable' | undefined;
  directory: string | undefined;
}>;

/** Inline welcome panel; it scrolls away with the conversation (docs/13). */
export function WelcomePanel(props: WelcomeProps) {
  const model = () =>
    props.model !== undefined
      ? formatModelRef(props.model)
      : props.modelStatus === 'loading'
        ? 'Loading model…'
        : props.modelStatus === 'unavailable'
          ? 'model unavailable'
          : undefined;
  const detail = () => {
    const current = model();
    const agent = props.agent;
    if (agent === undefined) return current ?? 'agent unavailable';
    return current === undefined ? agent : `${agent} · ${current}`;
  };
  const directory = () => props.directory ?? props.controller.cwd;
  /** The hints only appear when the cat, the details and the hints all fit unsqueezed. */
  const wide = () =>
    props.width >= catWidth + 2 + Math.max(detail().length, directory().length, 16) + 2 + hintWidth;
  // Borderless on purpose (#194): the text column starts one row above the cat and ends
  // with the version as a subdued row under the working directory.
  return (
    <box flexDirection="column" marginBottom={1} flexShrink={0}>
      <box flexDirection="row">
        <box flexDirection="column" marginTop={1} marginRight={2} width={catWidth} flexShrink={0}>
          <For each={cat}>{(line) => <text fg={props.theme.accent}>{line}</text>}</For>
        </box>
        <box flexDirection="column" flexGrow={1}>
          <text fg={props.theme.text}>
            <b>{props.greeting}</b>
          </text>
          <text fg={props.theme.dim}>{detail()}</text>
          <text fg={props.theme.dim}>{directory()}</text>
          <text fg={props.theme.dim}>{`margarita v${props.controller.version}`}</text>
        </box>
        <Show when={wide()}>
          <box flexDirection="column" marginLeft={2} flexShrink={0}>
            <text fg={props.theme.dim}>← overview (empty prompt)</text>
            <text fg={props.theme.dim}>Alt+P model</text>
            <text fg={props.theme.dim}>Ctrl+O details · F1 help</text>
          </box>
        </Show>
      </box>
    </box>
  );
}

function nodeID(key: string): string {
  return `node:${key}`;
}

/** An execution marker in its streaming phase, the row the queued preview sits above. */
function isRunningExecution(node: TranscriptNode): boolean {
  return node.kind === 'execution' && node.segment.phase === 'running';
}

/** Whether this row is the focused tool group (or its inline diff, keyed by tool id). */
function isNodeFocused(node: TranscriptNode, focusedGroup: string | undefined): boolean {
  if (focusedGroup === undefined) return false;
  if (node.kind === 'tool-group') return focusedGroup === node.key;
  if (node.kind === 'tool')
    return focusedGroup === `tool:${node.tool.id}` || focusedGroup === `diff:${node.tool.id}`;
  if (node.kind === 'worker') return focusedGroup === node.key;
  return false;
}

/** Worker tone comes only from the server's status, never from a client-side timer. */
function workerColor(status: WorkerStatus, theme: Theme): string {
  const colors: Record<WorkerStatus, string> = {
    running: theme.accentLight,
    error: theme.error,
    cancelled: theme.warn,
    completed: theme.dim,
  };
  return colors[status];
}

function NodeView(props: {
  node: TranscriptNode;
  theme: Theme;
  detailed: boolean;
  syntax: SyntaxStyle;
  width: number;
  focused: boolean;
  animate: boolean;
  ascii: boolean;
  mcpServers: readonly string[];
  now: number;
  /** Label of the user's effective `tools.background` binding, absent when unbound. */
  backgroundKey: string | undefined;
  /** True only when the server reports a running background job for this shell ID (#103). */
  backgroundShell: (shellID: string | undefined) => boolean;
  /** The retained worker rows were not re-confirmed on the last refresh (#230). */
  workerStale: boolean;
}) {
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
            <markdown
              content={sanitizeText(node().text)}
              syntaxStyle={props.syntax}
              treeSitterClient={getTreeSitterClient()}
              fg={theme().text}
              flexGrow={1}
              flexShrink={1}
            />
          </box>
        )}
      </Match>
      <Match when={props.node.kind === 'reasoning' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'reasoning'>>) => {
          // Model-provided reasoning is Markdown in detailed mode, bounded by rendered
          // rows (#223). Compact mode never emits this node at all.
          const bounded = () =>
            boundedPreview(
              sanitizeText(node().text),
              previewBudget('reasoning', props.detailed),
              Math.max(8, props.width - 4),
            );
          return (
            <box marginTop={1} flexDirection="column" paddingLeft={2}>
              <text fg={theme().dim}>
                <i>{node().done ? '∴ Reasoning (model-provided)' : '∴ Reasoning (in progress…)'}</i>
              </text>
              <box paddingLeft={1} flexDirection="column">
                <markdown
                  content={bounded().text}
                  syntaxStyle={props.syntax}
                  treeSitterClient={getTreeSitterClient()}
                  fg={theme().text}
                  flexGrow={1}
                  flexShrink={1}
                />
                <Show when={bounded().hiddenRows > 0}>
                  <text fg={theme().dim}>
                    {`… ${bounded().hiddenRows} more rows · inspect to read the rest`}
                  </text>
                </Show>
              </box>
            </box>
          );
        }}
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
            syntax={props.syntax}
            width={props.width}
            focused={props.focused}
            mcpServers={props.mcpServers}
            userExpanded={node().userExpanded === true}
          />
        )}
      </Match>
      <Match when={props.node.kind === 'tool-group' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'tool-group'>>) => {
          // The background hint describes the one running call. It follows that call's own
          // row when the group is expanded, so the action is never shown twice (issue #111).
          const activeID = () => activeTool(node().tools)?.id;
          const hintText = (): string | undefined => {
            const key = props.backgroundKey;
            return key === undefined || !backgroundHint(node().live, props.now)
              ? undefined
              : `${key} to move to background`;
          };
          return (
            <box flexDirection="column" marginTop={1}>
              <text fg={props.focused ? theme().accent : theme().dim}>
                {`${props.focused ? '▸' : ' '}  ${node().summary}${node().running ? '…' : ''}${
                  props.focused ? '  (Enter)' : ''
                }`}
              </text>
              {/* One continuously updated action, only while the group is collapsed. */}
              <Show when={!node().expanded}>
                <Show when={node().live}>
                  {(live: Accessor<LiveTool>) => (
                    <>
                      <text fg={theme().dim}>
                        {`    └ ${truncateToWidth(sanitizeText(live().text), Math.max(8, props.width - 6))}`}
                      </text>
                      <Show when={hintText()}>
                        {(text: Accessor<string>) => (
                          <text fg={theme().dim}>{`      └ ${text()}`}</text>
                        )}
                      </Show>
                    </>
                  )}
                </Show>
              </Show>
              <Show when={node().expanded}>
                <For each={node().tools}>
                  {(tool) => (
                    <>
                      <ToolView
                        tool={tool}
                        expanded
                        detailed={props.detailed}
                        theme={theme()}
                        syntax={props.syntax}
                        width={props.width}
                        focused={false}
                        mcpServers={props.mcpServers}
                        userExpanded={false}
                      />
                      <Show when={activeID() === tool.id ? hintText() : undefined}>
                        {(text: Accessor<string>) => (
                          <text fg={theme().dim}>{`      └ ${text()}`}</text>
                        )}
                      </Show>
                    </>
                  )}
                </For>
              </Show>
            </box>
          );
        }}
      </Match>
      <Match when={props.node.kind === 'shell' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'shell'>>) => {
          const bounded = () =>
            boundedPreview(
              sanitizeText(node().output ?? ''),
              previewBudget('shell', props.detailed),
              Math.max(8, props.width - 4),
            );
          return (
            <box flexDirection="column" marginTop={1}>
              <text fg={theme().text}>
                {`! ${truncateToWidth(sanitizeText(node().command), Math.max(8, props.width - 3))}`}
              </text>
              <text
                fg={
                  node().exitCode !== undefined && node().exitCode !== 0
                    ? theme().error
                    : node().status === 'timeout' && props.backgroundShell(node().shellID)
                      ? theme().warn
                      : theme().dim
                }
              >
                {`  └ ${node().status}${node().exitCode === undefined ? '' : ` (exit ${node().exitCode})`}${node().status === 'timeout' && props.backgroundShell(node().shellID) ? ' · still running in background' : ''}`}
              </text>
              <Show when={node().output}>
                <box flexDirection="column">
                  <text fg={theme().dim}>{bounded().text.split('\n').join('\n    ')}</text>
                  <Show when={bounded().hiddenRows > 0}>
                    <text fg={theme().dim}>
                      {`    … ${bounded().hiddenRows} more rows · ${props.detailed ? 'inspect' : 'Ctrl+O'} to read the rest`}
                    </text>
                  </Show>
                  <Show when={node().outputTruncated === 'server'}>
                    <text fg={theme().warn}>
                      {'  └ output truncated by the server; full text not shown'}
                    </text>
                  </Show>
                </box>
              </Show>
            </box>
          );
        }}
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
      <Match when={props.node.kind === 'worker' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'worker'>>) => {
          const worker = () => node().worker;
          return (
            <box flexDirection="column" marginTop={1}>
              <text fg={workerColor(worker().status, props.theme)}>
                {`  ${props.focused ? '▸' : '◇'} ${sanitizeText(worker().agent)} · ${sanitizeText(worker().description)} — ${workerStatusLabel(worker().status)}${worker().status === 'running' ? '…' : ''}${props.workerStale ? ' · stale' : ''}${props.focused ? '  (Enter)' : ''}`}
              </text>
              <Show when={node().expanded}>
                <text fg={theme().dim}>{`      child session ${worker().childSessionID}`}</text>
                <Show when={worker().title !== undefined}>
                  <text fg={theme().dim}>{`      ${sanitizeText(worker().title ?? '')}`}</text>
                </Show>
                <text fg={theme().dim}>
                  {`      started ${new Date(worker().startedAt).toISOString()}`}
                </text>
                <Show when={worker().completedAt !== undefined}>
                  <text fg={theme().dim}>
                    {`      completed ${new Date(worker().completedAt ?? 0).toISOString()}`}
                  </text>
                </Show>
                <text fg={theme().dim}>{'      result lives in the child session transcript'}</text>
              </Show>
            </box>
          );
        }}
      </Match>
      <Match when={props.node.kind === 'execution' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'execution'>>) => (
          <ExecutionMarkerView
            segment={node().segment}
            width={props.width}
            theme={theme()}
            animate={props.animate}
            ascii={props.ascii}
          />
        )}
      </Match>
      <Match when={props.node.kind === 'meta' ? props.node : undefined}>
        {(node: Accessor<NodeOf<'meta'>>) => <text fg={theme().dim}>{`  ${node().text}`}</text>}
      </Match>
    </Switch>
  );
}

/** Renders one execution marker: live indicator while running, static after. */
function ExecutionMarkerView(props: {
  segment: ExecutionMarker;
  width: number;
  theme: Theme;
  animate: boolean;
  ascii: boolean;
}) {
  const running = () => props.segment.phase === 'running';
  const facts = (): ThrobberFacts => ({
    phase: props.segment.phase,
    startedAt: props.segment.startedAt,
    ...(props.segment.activity === undefined ? {} : { activity: props.segment.activity }),
  });
  const line = () => {
    const { phase, durationMs, completedAt } = props.segment;
    return phase === 'running'
      ? ''
      : markerText({
          phase,
          ...(durationMs === undefined ? {} : { durationMs }),
          ...(completedAt === undefined ? {} : { completedAt }),
        });
  };
  return (
    <Show
      when={running()}
      fallback={
        <text
          marginTop={1}
          fg={
            props.segment.phase === 'failed'
              ? props.theme.error
              : props.segment.phase === 'interrupted'
                ? props.theme.warn
                : props.theme.dim
          }
        >
          {`  ◌ ${line()}`}
        </text>
      }
    >
      <Throbber
        facts={facts()}
        width={props.width}
        theme={props.theme}
        animate={props.animate}
        ascii={props.ascii}
      />
    </Show>
  );
}

function indent(text: string): string {
  return text.split('\n').join('\n    ');
}

function ToolView(props: {
  tool: ToolCall;
  expanded: boolean;
  detailed: boolean;
  theme: Theme;
  syntax: SyntaxStyle;
  width: number;
  focused: boolean;
  mcpServers: readonly string[];
  /** The user explicitly grew this item beyond its mode default (#219). */
  userExpanded?: boolean;
}) {
  const edit = createMemo(() => (props.tool.status === 'error' ? undefined : editDiff(props.tool)));
  // A completed edit-like call with no usable patch must say so instead of degrading to a
  // bare row: the server gave us nothing to show, which is different from no change at all.
  const unavailable = createMemo(() =>
    edit() === undefined && props.tool.status === 'completed' && isEditLike(props.tool)
      ? (toolPath(props.tool) ?? 'unknown')
      : undefined,
  );
  const lineWidth = () => Math.max(8, props.width - 4);
  const resultPreviewKind = (): PreviewKind => {
    const preview = semanticPreview(props.tool);
    return preview.kind;
  };
  const resultRows = () =>
    previewBudget(resultPreviewKind(), props.detailed, props.userExpanded === true);
  // Cap the patch before materializing a native <diff>; never reparse a mid-hunk slice.
  const clamped = createMemo(() => {
    const shown = edit();
    return shown === undefined
      ? undefined
      : clampDiffPatch(
          shown.diff,
          previewBudget('diff', props.detailed, props.userExpanded === true),
        );
  });
  const showFullDiff = () => (clamped()?.hidden ?? 0) === 0;
  const clampHint = () =>
    props.detailed
      ? `… ${clamped()?.hidden ?? 0} more lines · inspect to read the rest`
      : `… ${clamped()?.hidden ?? 0} more lines · Enter to expand`;
  const resultPreview = createMemo(() => {
    const preview = semanticPreview(props.tool);
    const text = sanitizeText(preview.text);
    const bounded =
      props.tool.status === 'error'
        ? boundedTailPreview(text, resultRows(), lineWidth())
        : boundedPreview(text, resultRows(), lineWidth());
    return { ...bounded, kind: preview.kind };
  });
  const failed = () => props.tool.status === 'error';
  const scriptFailed = () => props.tool.executionError !== undefined;
  const childrenVisible = () =>
    props.tool.children !== undefined &&
    (props.expanded ||
      failed() ||
      scriptFailed() ||
      props.tool.children.some((c) => c.status === 'error'));

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
        <text fg={props.theme.text}>
          {sanitizeText(
            edit() !== undefined
              ? `${props.tool.name === 'write' ? 'Write' : 'Update'}(${describeTool(props.tool, props.mcpServers).slice(props.tool.name.length + 1)})`
              : unavailable() !== undefined
                ? `Changed(${unavailable()})`
                : describeTool(props.tool, props.mcpServers),
          )}
        </text>
        <Show when={props.detailed}>
          <text fg={props.theme.dim}>{`  ${formatToolTiming(props.tool, clock)}`}</text>
        </Show>
        <Show when={props.focused}>
          <text fg={props.theme.accent}>{props.detailed ? '  (I)' : '  (Enter)'}</text>
        </Show>
      </box>
      <Show when={props.tool.executionError}>
        {(error: Accessor<string>) => (
          <text fg={props.theme.error}>{`  └ script failed: ${sanitizeText(error())}`}</text>
        )}
      </Show>
      <Show when={props.tool.files !== undefined && props.tool.files.length > 0}>
        <For each={props.tool.files ?? []}>
          {(file) => (
            <text fg={props.theme.dim}>
              {`  └ ${file.name}${file.mime === undefined ? '' : ` · ${file.mime}`}${file.size === undefined ? '' : ` · ${formatBytes(file.size)}`}${file.uri === undefined ? '' : ` · ${sanitizeText(file.uri)}`}`}
            </text>
          )}
        </For>
      </Show>
      <Show when={childrenVisible() ? props.tool.children : undefined}>
        {(children: Accessor<NonNullable<ToolCall['children']>>) => (
          <box flexDirection="column" paddingLeft={2}>
            <For each={children()}>
              {(child) => (
                <text
                  fg={
                    child.status === 'error'
                      ? props.theme.error
                      : child.status === 'running' || child.status === 'streaming'
                        ? props.theme.accent
                        : props.theme.dim
                  }
                >
                  {`└ ${childStatusMark(child.status)} ${childLabel(child.name, props.mcpServers)}${childInputSummary(child.input)}`}
                </text>
              )}
            </For>
          </box>
        )}
      </Show>
      {/* Failures are never hidden, even in compact mode. */}
      <Show when={unavailable() !== undefined}>
        <text fg={props.theme.dim}>{'  └ diff unavailable for this change'}</text>
      </Show>
      <Show when={props.tool.error}>
        {(error: Accessor<string>) => {
          const bounded = () =>
            boundedTailPreview(
              sanitizeText(error()),
              previewBudget('output', props.detailed, props.userExpanded === true),
              lineWidth(),
            );
          return (
            <>
              <text fg={props.theme.error}>{`  └ ${indent(bounded().text)}`}</text>
              <Show when={bounded().hiddenRows > 0}>
                <text fg={props.theme.error}>
                  {`    … ${bounded().hiddenRows} earlier rows hidden · inspect for the full error`}
                </text>
              </Show>
            </>
          );
        }}
      </Show>
      <Show when={edit()}>
        {(shown: Accessor<NonNullable<ReturnType<typeof editDiff>>>) => (
          <box flexDirection="column" paddingLeft={2}>
            <text fg={props.theme.dim}>{`└ ${changeSummary(diffCounts(shown().diff))}`}</text>
            <Show
              when={showFullDiff()}
              fallback={
                <box flexDirection="column">
                  <For each={clamped()?.shown ?? []}>
                    {(line) => (
                      <text fg={diffLineFg(line.kind, props.theme)}>
                        {truncateToWidth(line.text, lineWidth())}
                      </text>
                    )}
                  </For>
                  <text fg={props.focused ? props.theme.accent : props.theme.dim}>
                    {`${props.focused ? '▸ ' : '  '}${clampHint()}`}
                  </text>
                </box>
              }
            >
              <diff
                diff={shown().diff}
                view="unified"
                showLineNumbers
                syntaxStyle={props.syntax}
                treeSitterClient={getTreeSitterClient()}
                filetype={shown().filetype}
                fg={props.theme.text}
                lineNumberFg={props.theme.dim}
                addedBg={props.theme.addedBg}
                removedBg={props.theme.removedBg}
                addedSignColor={props.theme.success}
                removedSignColor={props.theme.error}
                wrapMode="none"
              />
            </Show>
          </box>
        )}
      </Show>
      <Show
        when={
          edit() === undefined && props.expanded && props.tool.output !== undefined && !failed()
        }
      >
        <box flexDirection="column">
          <text fg={props.theme.dim}>{`  └ ${indent(resultPreview().text)}`}</text>
          <Show when={resultPreview().hiddenRows > 0}>
            <text fg={props.theme.dim}>
              {`    … ${resultPreview().hiddenRows} more rows · inspect to read the rest`}
            </text>
          </Show>
        </box>
      </Show>
      <Show when={props.tool.outputTruncated !== undefined}>
        <text fg={props.theme.warn}>
          {props.tool.outputTruncated === 'server'
            ? '  └ output truncated by the server; the full text is not available here'
            : '  └ output elided by this program (middle omitted); the full text was not retained'}
        </text>
      </Show>
    </box>
  );
}

function plural(count: number): string {
  return `${count} ${count === 1 ? 'line' : 'lines'}`;
}

function childStatusMark(status: ToolCallChild['status']): string {
  if (status === 'completed') return '✓';
  if (status === 'error') return '✗';
  return '…';
}

function childLabel(name: string, mcpServers: readonly string[]): string {
  const identity = toolIdentity(name, mcpServers);
  return identity.kind === 'mcp' ? `${identity.server}.${identity.tool}` : sanitizeText(name);
}

function childInputSummary(input: ToolCallChild['input']): string {
  if (input === undefined) return '';
  const value = Object.values(input).find(
    (entry) => typeof entry === 'string' && entry.trim() !== '',
  );
  if (typeof value !== 'string') return '';
  const line = value.split('\n')[0] ?? value;
  return `  ${truncatePrompt(sanitizeText(line), 72)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Compact-mode colours for a clipped patch line; semantics match the full <diff> view. */
function diffLineFg(kind: PatchLine['kind'], theme: Theme): string {
  switch (kind) {
    case 'add':
      return theme.success;
    case 'del':
      return theme.error;
    case 'hunk':
      return theme.accent;
    case 'meta':
    case 'context':
      return theme.dim;
    default:
      return theme.text;
  }
}

/** Clip a pre-sanitized patch line to one terminal row; never wraps, so rows stay bounded. */
function truncateToWidth(text: string, width: number): string {
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function changeSummary(counts: { additions: number; deletions: number }): string {
  return `Added ${plural(counts.additions)}, removed ${plural(counts.deletions)}`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour12: false });
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

/** A pending agent question. It never takes focus by itself; a dedicated key opens it. */
function FormCard(props: { controller: AppController; theme: Theme; keymap: Keymap }) {
  const pending = () =>
    props.controller.pendingPermission() === undefined ? props.controller.pendingForm() : undefined;
  const openHint = () => actionHint(props.keymap, 'form.open') ?? 'Alt+Q';
  /** Count with the editor's own hidden/conditional rules, not the wire field list (#235). */
  const fieldCount = () => {
    const form = pending();
    return form === undefined ? 0 : initialVisibleFields(form).length;
  };
  return (
    <Show when={pending()}>
      {(form: Accessor<FormRequest>) => (
        <box
          border
          borderStyle="rounded"
          borderColor={props.theme.warn}
          title=" Question from the agent "
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          marginTop={1}
          flexShrink={0}
        >
          <text fg={props.theme.text}>
            <b>{form().title}</b>
          </text>
          <text fg={props.theme.dim}>
            {fieldCount() === 0
              ? `No questions to answer · ${openHint()} to acknowledge · Enter on an empty prompt also opens it`
              : `${fieldCount()} field${fieldCount() === 1 ? '' : 's'} · ${openHint()} to answer · Enter on an empty prompt also opens it`}
          </text>
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
  serverID: string;
  directory: string;
  theme: Theme;
  width: number;
}) {
  const overview = () => props.controller.state.overview;
  const newModel = () => props.controller.modelFor(props.serverID, props.directory);
  return (
    <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
      <WelcomePanel
        controller={props.controller}
        theme={props.theme}
        width={props.width}
        greeting={props.controller.greetingFor(`new:${props.serverID}:${props.directory}`)}
        agent={overview().agent}
        model={newModel().model}
        modelStatus={newModel().status}
        directory={props.directory}
      />
    </scrollbox>
  );
}
