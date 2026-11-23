/**
 * Memoized inspector document (#315).
 *
 * Materializing an inspector index from a tool payload is reused across renders
 * until the payload changes, so scrolling and searching never rebuild it. This
 * cache owns that single entry; the pure projector stays in the domain layer.
 */
import { type InspectorIndex, inspectorIndex } from '../domain/inspector.ts';
import type { ToolResultPayload } from '../domain/transcript.ts';

/** Caches the materialized document for the current tool payload. */
export class InspectorDocumentCache {
  private cache: { payload: ToolResultPayload | undefined; index: InspectorIndex } | undefined;

  /** Returns the document for `payload`, building it only when the payload changed. */
  get(payload: ToolResultPayload | undefined): InspectorIndex {
    if (this.cache !== undefined && this.cache.payload === payload) return this.cache.index;
    const index = inspectorIndex(payload ?? { files: [], completeness: 'complete' });
    this.cache = { payload, index };
    return index;
  }
}
