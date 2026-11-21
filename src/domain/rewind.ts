import { truncatePrompt } from './sticky-prompt.ts';
import type { TranscriptMessage } from './transcript.ts';

/**
 * A prior user prompt that can be used as a server-side revert boundary.
 * OpenCode's `session.revert.stage` takes a message ID; the boundary is the *user message*
 * itself, so a candidate is never inferred from a tool call or an assistant reply.
 */
export type RewindCandidate = Readonly<{
  messageID: string;
  createdAt: number;
  /** Short single-line preview of the prompt. */
  text: string;
  /** 1-based ordinal in prompt order, for stable numbering across redraws. */
  ordinal: number;
}>;

/**
 * Compact timestamp for a prompt row. We render UTC with an explicit `UTC` suffix so the
 * clock is never mistaken for local time in any timezone (#145). A corrupt or unrepresentable
 * server value stays visibly unknown and never throws into the renderer.
 */
export function rewindTimeLabel(createdAt: number): string {
  if (!Number.isFinite(createdAt)) return 'time unknown';
  const date = new Date(createdAt);
  // A finite but out-of-range millisecond value yields an Invalid Date whose getTime() is NaN;
  // calling toISOString() on it would throw RangeError.
  if (!Number.isFinite(date.getTime())) return 'time unknown';
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** All user prompts in the loaded transcript, oldest first. Page up to load earlier ones. */
export function rewindCandidates(messages: readonly TranscriptMessage[]): RewindCandidate[] {
  let ordinal = 0;
  return messages.flatMap((message) => {
    if (message.kind !== 'user') return [];
    ordinal += 1;
    return [
      {
        messageID: message.id,
        createdAt: message.createdAt,
        text: truncatePrompt(message.text, 60),
        ordinal,
      },
    ];
  });
}
