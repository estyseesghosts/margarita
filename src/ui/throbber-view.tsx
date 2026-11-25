import type { Accessor } from 'solid-js';
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';

import { graphemes } from '../domain/composer.ts';
import {
  describeThrobber,
  frameAt,
  shimmerWeights,
  type ThrobberFacts,
  throbberTickMs,
  tipFor,
} from '../domain/throbber.ts';
import { strings } from '../i18n/index.ts';
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
  // A finished turn owns no timer; non-animated running turns still refresh the visible
  // elapsed counter, but at one second rather than the 150 ms shimmer cadence (#290).
  createEffect(() => {
    const running = props.facts.phase === 'running';
    const tickMs = throbberTickMs(running, props.animate);
    if (tickMs === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), tickMs);
    onCleanup(() => clearInterval(timer));
  });

  const line = createMemo(() =>
    describeThrobber(props.facts, now(), props.width, (at) => timeFormat.format(new Date(at))),
  );
  const elapsed = () => now() - props.facts.startedAt;
  const glyph = () => {
    if (!line().animated) return '◌';
    if (props.animate) return frameAt(elapsed(), props.ascii);
    return props.ascii ? '*' : '◜';
  };
  const weights = createMemo(() =>
    props.animate ? shimmerWeights(line().label.length, now()) : [],
  );
  const colour = (index: number) =>
    blend(props.theme.accent, props.theme.accentLight, weights()[index] ?? 0);
  const tip = () => (line().animated ? tipFor(props.facts.startedAt, elapsed()) : undefined);

  return (
    <box flexDirection="column" marginTop={1}>
      <text>
        <span style={{ fg: line().animated ? colour(0) : props.theme.dim }}>{glyph()} </span>
        <Show
          when={props.animate}
          fallback={<span style={{ fg: props.theme.dim }}>{line().label}</span>}
        >
          <For each={graphemes(line().label)}>
            {(char, index) => <span style={{ fg: colour(index()) }}>{char}</span>}
          </For>
        </Show>
        <span style={{ fg: props.theme.dim }}>
          {line().label === '' ? line().meta : ` ${line().meta}`}
        </span>
      </text>
      <Show when={tip()}>
        {(text: Accessor<string>) => (
          <text fg={props.theme.dim}>{`  └ ${strings.throbber.tipPrefix} ${text()}`}</text>
        )}
      </Show>
    </box>
  );
}
