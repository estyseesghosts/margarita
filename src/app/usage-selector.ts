/**
 * Memoized usage analytics selector (#316/#318).
 *
 * The context meter and `/usage` summary must never disagree, so one projector
 * serves both. This selector owns the single-entry cache and the "reuse until
 * evidence changes" rule; callers supply evidence read from state, and the
 * projector stays pure in the domain layer.
 */
import { projectUsage, type UsageAnalytics, type UsageInput } from '../domain/usage-analytics.ts';

/** True when every evidence field the projection depends on is unchanged. */
function sameEvidence(previous: UsageInput, next: UsageInput): boolean {
  return (
    previous.serverID === next.serverID &&
    previous.sessionID === next.sessionID &&
    previous.messages === next.messages &&
    previous.tokens === next.tokens &&
    previous.cost === next.cost &&
    previous.catalog === next.catalog &&
    previous.mcpServers === next.mcpServers &&
    previous.stale === next.stale
  );
}

/** Reuses one projection until transcript, usage or catalog evidence changes (#285). */
export class UsageAnalyticsSelector {
  private cache: { input: UsageInput; result: UsageAnalytics } | undefined;

  select(input: UsageInput): UsageAnalytics {
    const cached = this.cache;
    if (cached !== undefined && sameEvidence(cached.input, input)) return cached.result;
    const result = projectUsage(input);
    this.cache = { input, result };
    return result;
  }
}
