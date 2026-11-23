/**
 * Single-flight prompt admission per server-qualified session (#312).
 *
 * A second Enter to the same session while its request is in flight must not be
 * silently discarded — the user gets an explicit notice — while other sessions
 * and hosts stay independent. This gate owns exactly that in-flight set; model
 * and agent confirmation checks remain with their own owners.
 */
export class AdmissionGate {
  private readonly admitting = new Set<string>();

  /** True while a submission for `key` is still in flight. */
  isAdmitting(key: string): boolean {
    return this.admitting.has(key);
  }

  /** Claims `key`; returns false when another submission already holds it. */
  begin(key: string): boolean {
    if (this.admitting.has(key)) return false;
    this.admitting.add(key);
    return true;
  }

  /** Releases `key` after the submission settles. Releasing an unclaimed key is a no-op. */
  end(key: string): void {
    this.admitting.delete(key);
  }
}
