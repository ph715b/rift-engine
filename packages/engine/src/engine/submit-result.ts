/** Mirrors engine/SubmitResult.java's sealed interface (Ok/Invalid/GameOver). */
export type SubmitResult =
  | { type: "Ok" }
  | { type: "Invalid"; error: string }
  | { type: "GameOver"; winnerId: string };
