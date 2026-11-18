import { formatElapsed } from '../domain/throbber.ts';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export type FinishedMarker = Readonly<{
  phase: 'completed' | 'failed' | 'interrupted';
  durationMs?: number;
  completedAt?: number;
}>;

/** Text of a finished task marker. The single status glyph is added by the view, not here. */
export function markerText(marker: FinishedMarker): string {
  const status =
    marker.phase === 'completed'
      ? 'Completed'
      : marker.phase === 'failed'
        ? 'Failed'
        : 'Interrupted';
  const preposition = marker.phase === 'completed' ? 'in' : 'after';
  const event =
    marker.durationMs === undefined
      ? status
      : `${status} ${preposition} ${formatElapsed(marker.durationMs)}`;
  return marker.completedAt === undefined
    ? event
    : `${event} · done ${timeFormat.format(new Date(marker.completedAt))}`;
}
