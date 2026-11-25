import { formatElapsed } from '../domain/throbber.ts';
import { strings } from '../i18n/index.ts';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export type FinishedMarker = Readonly<{
  phase: 'completed' | 'failed' | 'interrupted';
  durationMs?: number;
  completedAt?: number;
}>;

/** Text of a finished task marker. The single status glyph is added by the view, not here. */
export function markerText(marker: FinishedMarker): string {
  const stringsForMarker = strings.transcript.marker;
  const status =
    marker.phase === 'completed'
      ? stringsForMarker.completed
      : marker.phase === 'failed'
        ? stringsForMarker.failed
        : stringsForMarker.interrupted;
  const preposition =
    marker.durationMs === undefined
      ? undefined
      : marker.phase === 'completed'
        ? stringsForMarker.in
        : stringsForMarker.after;
  const event = stringsForMarker.event(
    status,
    preposition,
    marker.durationMs === undefined ? '' : formatElapsed(marker.durationMs),
  );
  return marker.completedAt === undefined
    ? event
    : stringsForMarker.done(event, timeFormat.format(new Date(marker.completedAt)));
}
