/**
 * Single-flight prompt admission per server-qualified session (#312).
 *
 * A second Enter to the same session while its request is in flight must not be
 * silently discarded - the user gets an explicit notice - while other sessions
 * and hosts stay independent. This gate owns exactly that in-flight set; model
 * and agent confirmation checks remain with their own owners.
 */
export class AdmissionGate {
  private readonly admitting = new Set<string>();
  private readonly owners = new Map<string, symbol>();

  /** True while a submission for `key` is still in flight. */
  isAdmitting(key: string): boolean {
    return this.admitting.has(key);
  }

  /** Claims `key`; returns false when another submission already holds it. */
  begin(key: string): boolean {
    if (this.admitting.has(key)) return false;
    this.admitting.add(key);
    this.owners.set(key, Symbol(key));
    return true;
  }

  /**
   * Claims `key` with an opaque owner token. Only the matching token may release it, so a
   * flight that settles after teardown or replacement cannot unlock its successor (#337).
   */
  beginOwned(key: string): symbol | undefined {
    if (this.admitting.has(key)) return undefined;
    const token = Symbol(key);
    this.admitting.add(key);
    this.owners.set(key, token);
    return token;
  }

  /** Releases `key` only when `token` still owns it; returns whether a claim was released. */
  endOwned(key: string, token: symbol): boolean {
    if (this.owners.get(key) !== token) return false;
    this.owners.delete(key);
    this.admitting.delete(key);
    return true;
  }

  /** Releases `key` after the submission settles. Releasing an unclaimed key is a no-op. */
  end(key: string): void {
    this.admitting.delete(key);
    this.owners.delete(key);
  }

  /** Drops every claim; used when the owning controller is disposed. */
  clear(): void {
    this.admitting.clear();
    this.owners.clear();
  }
}
