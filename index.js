/**
 * Host half of the Context Meter bundle.
 *
 * The feature is entirely a Web UI addition: `client.js` registers one compact
 * reading into `conversation.input.left` and computes it in the browser from the
 * Session's own `contextPressure` projection plus the frozen `request/header`
 * maxTokens. The Host therefore owns no services, tools, or listeners and only
 * needs a plugin row so the Client half is loaded for the profile.
 */
export function apply() {}
