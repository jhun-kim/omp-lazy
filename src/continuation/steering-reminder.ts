/**
 * Steering reminder appended to additionalContext on idle continuation.
 *
 * This is NOT a rewritten prompt, NOT a sendUserMessage, and NOT a directive.
 * It lives only inside the session_stop result's `additionalContext` property
 * to steer the agent without user-visible messages or prompt rewrites.
 *
 * The reminder must appear EXACTLY ONCE per idle edge in additionalContext.
 * The activation suppression already prevents the continuation text from
 * re-triggering a directive on the next turn.
 */

/**
 * The single steering reminder sentence appended when a run is active.
 * Intentionally short and invariant so it does not dominate the context.
 */
export const STEERING_REMINDER =
  "You are in an active run. Continue executing the current task without waiting for further user input."

/**
 * Append the steering reminder to the coordinator's additionalContext.
 * Returns the combined string. Never mutates the input.
 */
export function appendSteeringReminder(additionalContext: string): string {
  return `${additionalContext}\n\n${STEERING_REMINDER}`
}
