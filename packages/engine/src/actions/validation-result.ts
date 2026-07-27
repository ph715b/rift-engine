/** Mirrors engine/ValidationResult.java's `record ValidationResult(boolean valid, String error)`. */
export type ValidationResult = { ok: true } | { ok: false; error: string };

export function ok(): ValidationResult {
  return { ok: true };
}

export function fail(error: string): ValidationResult {
  return { ok: false, error };
}
