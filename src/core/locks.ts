/** Per-run execution fence shared by model calls and credential release. */
export const MODEL_INVOCATION_LOCK_SEED = 17;

/** Per-action session fence held across reconciliation, dispatch, and receipt commit. */
export const GOVERNED_ACTION_LOCK_SEED = 29;
