/** Shared, testable copy for the per-minute pacing control, so the builder and the campaign list
 * cannot drift apart on the one sentence the founder asked to be explicit. */
export const NO_PER_MINUTE_LABEL = "No per-minute limit — sends go back to back";

export const PER_MINUTE_MAX = 6;

export const PER_MINUTE_RANGE_HINT = `Leave it empty for no per-minute limit, or enter a whole number from 1 to ${PER_MINUTE_MAX}.`;

/** What a stored cap means, in the founder's words. NULL is the sanctioned "no limit", never an unset bug. */
export function perMinuteSummary(cap: number | null): string {
  return cap === null ? NO_PER_MINUTE_LABEL : `${cap} per minute`;
}
