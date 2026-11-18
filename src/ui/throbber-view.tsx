import type { Accessor } from 'solid-js';
import { createSignal, For, onCleanup, Show } from 'solid-js';

import { graphemes } from '../domain/composer.ts';
import {
  describeThrobber,
  frameAt,
  frameIntervalMs,
  shimmerWeights,
  type ThrobberFacts,
  tipFor,
} from '../domain/throbber.ts';
import { blend, type Theme } from './theme.ts';

export type ThrobberProps = Readonly<{
  facts: ThrobberFacts;
  width: number;
  theme: Theme;
  animate: boolean;
  ascii: boolean;
}>;

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * One line attached to the latest turn. Only a running turn ticks; the timer is
 * created per mount and cleared on unmount, so finished turns never redraw.
 */
export function Throbber(props: ThrobberProps) {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => {
    if (props.facts.phase === 'running') setNow(Date.now());
  }, frameIntervalMs);
  onCleanup(() => clearInterval(timer));

  const line = () =>
    describeThrobber(props.facts, now(), props.width, (at) => timeFormat.format(new Date(at)));
  const elapsed = () => now() - props.facts.startedAt;
  // Without animation, only the elapsed counter changes (once per second via the meta text).
  const glyph = () =>
    !line().animated
      ? '◌'
      : props.animate
        ? frameAt(elapsed(), props.ascii)
        : props.ascii
          ? '*'
          : '◜';
  const weights = () => (props.animate ? shimmerWeights(line().label.length, now()) : []);
  const colour = (index: number) =>
    blend(props.theme.accent, props.theme.accentLight, weights()[index] ?? 0);
  const tip = () => (line().animated ? tipFor(props.facts.startedAt, elapsed()) : undefined);

  return (
    <box flexDirection="column" marginTop={1}>
      <text>
        <span style={{ fg: line().animated ? colour(0) : props.theme.dim }}>{glyph()} </span>
        <For each={graphemes(line().label)}>
          {(char, index) => <span style={{ fg: colour(index()) }}>{char}</span>}
        </For>
        <span style={{ fg: props.theme.dim }}>
          {line().label === '' ? line().meta : ` ${line().meta}`}
        </span>
      </text>
      <Show when={tip()}>
        {(text: Accessor<string>) => <text fg={props.theme.dim}>{`  └ Tip: ${text()}`}</text>}
      </Show>
    </box>
  );
}
