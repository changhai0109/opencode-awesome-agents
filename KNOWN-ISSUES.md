# Known issues

## 1. Errored tool part in history breaks strict OpenAI-compatible providers (opencode 1.18.31)

**Status:** observed 2026-09-19, tracked locally (upstream issue filed then withdrawn).

**Symptom:** on `kimi-code-plan-cn/k3` (Moonshot endpoint), any request fails with:

> an assistant message with 'tool_calls' must be followed by tool messages
> responding to each 'tool_call_id'. The following tool_call_ids did not have
> response messages: skill:0, glob:1, glob:2, read:3, read:4

**Root cause (from session DB):** an old turn in the same session held 5
parallel tool calls (`skill`, `glob`, `glob`, `read`, `read`) where the
`skill` part ended in status `error`
(`<tool_use_error>Unknown skill: customize-opencode</tool_use_error>`).
When opencode converts that history for an OpenAI-compatible provider, it
re-emits the assistant `tool_calls` (with rebuilt `tool:index` IDs) but
produces no paired `tool` response for the failed call. Lenient providers
(Claude API, opencode provider) accept the payload; strict ones (Moonshot)
reject it. Retrying in the same session keeps failing — the poisoned turn is
baked into history.

**Not caused by this roster:** the failure hit the scheduler's own turn; no
`subagent_dispatch` call was involved, and dispatched children get clean
single-prompt histories, so they are unaffected.

**Workaround:** start a fresh session (or compact) instead of retrying when
this error appears — especially after switching to Kimi mid-session.

**Fix (upstream):** errored tool parts should convert to paired `tool`
response messages carrying the error text (which the OpenAI API allows), or
the dangling `tool_call` should be dropped.
