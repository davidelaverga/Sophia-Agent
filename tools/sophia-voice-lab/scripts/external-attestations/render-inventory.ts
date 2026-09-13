/** A malformed authoritative inventory is not transient absence. Retrying a
 * later subset must not conceal the record that prevented an owner-death proof. */
export class RenderInventoryError extends Error {}

export function parseRenderInventory<T>(parse: () => T): T {
  try { return parse(); }
  catch { throw new RenderInventoryError("Render instance inventory is malformed; owner absence cannot be proven."); }
}

export function retryableRenderObservation(error: unknown): null {
  if (error instanceof RenderInventoryError) throw error;
  return null;
}
