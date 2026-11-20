import { useKeyboard, usePaste, useRenderer, useTerminalDimensions } from '@opentui/solid';
import type { Accessor } from 'solid-js';
import { createSignal, Match, onCleanup, Show, Switch } from 'solid-js';

import type { AppController } from '../app/controller.ts';
import { type KeyInput, routeKey, type ScrollMove } from '../app/key-router.ts';
import { composerFrom, graphemes } from '../domain/composer.ts';
import type { Keymap } from '../domain/keymap.ts';
import { ComposerView, Footer } from './composer-view.tsx';
import { editExternally } from './external-editor.ts';
import { OverlayView } from './overlays.tsx';
import { Overview } from './overview-view.tsx';
import type { Theme } from './theme.ts';
import { NewSessionView, Transcript } from './transcript-view.tsx';

export type AppProps = Readonly<{
  controller: AppController;
  keymap: Keymap;
  theme: Theme;
  animate: boolean;
  ascii: boolean;
  env: NodeJS.ProcessEnv;
  /** How often the 10s background hint threshold is re-checked (default 1s). */
  hintTickMs?: number;
}>;

/** Structural subset of a terminal key event; KeyEvent satisfies this. */
export type KeyEventLike = Readonly<{
  name: string;
  ctrl: boolean;
  meta: boolean;
  option: boolean;
  shift: boolean;
  sequence: string;
}>;

export function toKeyInput(event: KeyEventLike): KeyInput {
  const sequence = event.sequence;
  const printable = sequence.length > 0 && graphemes(sequence).length === 1 && !event.ctrl;
  return {
    name: event.name === 'enter' ? 'return' : event.name,
    ctrl: event.ctrl,
    alt: event.meta || event.option,
    shift: event.shift,
    ...(printable ? { text: sequence } : {}),
  };
}

export function App(props: AppProps) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const controller = props.controller;
  const state = controller.state;
  const [now, setNow] = createSignal(controller.now());
  const clock = setInterval(() => setNow(controller.now()), 30_000);
  onCleanup(() => clearInterval(clock));
  let editing = false;

  const openEditor = () => {
    if (editing) return;
    editing = true;
    void editExternally(renderer, state.composer.text, props.env)
      .then((result) => {
        if (result.ok) controller.setComposer(composerFrom(result.text));
        else controller.showNotice(result.message, 'warn');
      })
      .finally(() => {
        editing = false;
      });
  };

  let scrollTranscript: ((move: ScrollMove) => void) | undefined;

  useKeyboard((event) => {
    if (editing || event.eventType === 'release') return;
    props.controller.debugKey({
      name: event.name === 'enter' ? 'return' : event.name,
      ctrl: event.ctrl,
      alt: event.meta || event.option,
      shift: event.shift,
      eventType: event.eventType,
      sequenceLength: event.sequence.length,
    });
    const handled = routeKey(controller, props.keymap, toKeyInput(event), {
      openEditor,
      redraw: () => renderer.requestRender(),
      scroll: (move) => scrollTranscript?.(move),
    });
    if (handled) event.preventDefault();
  });

  usePaste((event) => {
    if (state.overlay.kind === 'help') controller.closeOverlay();
    if (state.overlay.kind !== 'none') return;
    void controller.pasteBytes(event.bytes);
  });

  const width = () => dimensions().width;

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      onMouseDown={() => {
        if (state.overlay.kind === 'help') controller.closeOverlay();
      }}
    >
      <Switch>
        <Match when={state.route.kind === 'conversation' ? state.route : undefined}>
          {(route: Accessor<{ kind: 'conversation'; serverID: string; sessionID: string }>) => (
            <Transcript
              controller={controller}
              keymap={props.keymap}
              sessionID={route().sessionID}
              serverID={route().serverID}
              theme={props.theme}
              width={width()}
              animate={props.animate}
              ascii={props.ascii}
              hintTickMs={props.hintTickMs}
              onScrollHandle={(handle) => {
                scrollTranscript = handle;
              }}
            />
          )}
        </Match>
        <Match when={state.route.kind === 'new' ? state.route : undefined}>
          {(route: Accessor<{ kind: 'new'; serverID: string; directory: string }>) => (
            <NewSessionView
              controller={controller}
              serverID={route().serverID}
              directory={route().directory}
              theme={props.theme}
              width={width()}
            />
          )}
        </Match>
        <Match when={state.route.kind === 'overview'}>
          <Overview controller={controller} theme={props.theme} now={now()} ascii={props.ascii} />
        </Match>
      </Switch>
      <Show when={state.overlay.kind !== 'none'}>
        <OverlayView controller={controller} keymap={props.keymap} theme={props.theme} />
      </Show>
      <ComposerView controller={controller} theme={props.theme} width={width()} />
      <Footer controller={controller} theme={props.theme} width={width()} />
    </box>
  );
}
