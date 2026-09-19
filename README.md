# opencode-awesome-agents

A tiered subagent roster for [opencode](https://opencode.ai) with a
**scheduler** that decomposes problems, picks a model *per dispatch* by
difficulty and budget, and delegates through a custom `subagent_dispatch`
plugin tool — the piece opencode's built-in `task` tool is missing (it cannot
override a subagent's model at call time).

## How it works

- **Roster agents carry no model pin.** All seven subagents in
  `.opencode/agent/` define only a role prompt and permissions. The model is
  chosen at dispatch time.
- **`subagent_dispatch`** (`.opencode/plugin/subagent-dispatcher.ts`) is a
  plugin tool that spawns a roster subagent on a caller-chosen model. It
  bypasses the `task` tool and uses the opencode SDK directly
  (`session.create({ parentID })` + `session.prompt({ agent, model })`),
  which *does* accept an explicit model override. It takes either a `tier`
  name (expands to a ranked model list with automatic fallback) or an
  explicit ranked `models` list, plus an optional usability `probe`.
- **The scheduler** is a primary agent that triages, decomposes, dispatches
  lite-first, integrates, and sends every non-trivial change through a
  reviewer. It never writes code itself (`edit: deny`), and the plain `task`
  tool is denied everywhere — with no model pins, a task dispatch would
  silently inherit the caller's model.

## Model tiers

Each tier is a ranked list; `subagent_dispatch` tries entries in order and
falls back on failure. Defined in the plugin's `defaults.tiers` (overridable
via plugin options) and mirrored in `scheduler.md`.

| Tier | Rough cost | Models, best first |
|---|---|---|
| **premium** | ~10× | `kimi-code-plan-cn/k3` → `openai/gpt-6-astra` → `openai/gpt-5.6-sol` → `claude-code/claude-fable-5` |
| **plus** | ~3× | `openai/gpt-5.6-terra` → `claude-code/claude-sonnet-5` |
| **regular** | ~1× | `openai/gpt-5.6-luna` → `minimax-cn-coding-plan/MiniMax-M3` → `claude-code/claude-haiku-4-5` |

`claude-code/...` entries sit last in every tier deliberately: sessions on
the claude-code provider cannot see custom plugin tools (its bridge exposes
only a fixed proxy set), so a spawn-capable agent that lands on a Claude
fallback works solo instead of sub-delegating. Keep the scheduler on a
natively-provided model.

## The roster

| Agent | Default tier | Role | Spawns? |
|---|---|---|---|
| `scheduler` | — (pinned `kimi-code-plan-cn/k3`) | Decompose, dispatch, integrate, verify | everything |
| `explorer-lite` | regular | Needle queries: find a definition, list usages | leaf |
| `explorer` | plus | Open-ended codebase questions, synthesized answers | explorer-lite fan-out |
| `coder-lite` | regular | Mechanical, fully-specified edits | leaf |
| `coder` | plus | Typical implementation: features, fixes, small refactors | explorers, coder-lite |
| `coder-max` | premium | Hard problems: subtle bugs, cross-cutting changes | explorers, cheaper coders |
| `reviewer` | plus | Routine review of small/medium diffs; read-only | leaf |
| `reviewer-max` | premium | Review of subtle/security/concurrency changes; read-only | leaf |

Default tiers are conventions, not pins — the scheduler may dispatch
off-tier (e.g. `reviewer` at premium for one risky diff).

**Lite-first policy:** the scheduler's default answer to every subtask is the
lite agent at tier regular; escalation requires a concrete named reason, and
a bounced lite attempt is treated as cheap reconnaissance. Escalation
ladders run one rung at a time:

- research: `explorer-lite`@regular → `explorer`@plus → `explorer`@premium
- implementation: `coder-lite`@regular → `coder`@plus → `coder-max`@premium
- review: `reviewer`@plus → `reviewer-max`@premium

## Depth limiting

Three independent layers:

- **Protocol (operational):** every dispatch prompt begins with a
  `[scheduler-protocol]` header carrying `depth`, `max_depth` (default 2,
  raisable to 3 when justified), and a `spawn_budget` that children split
  among their own dispatches. The header is the child's context.
- **Budget ledger (hard):** the plugin keeps a per-session budget map and
  enforces the `spawn_budget` tool arg — each dispatch costs 1 plus the
  child's granted budget against the caller's remainder, and over-budget
  calls are refused. The root session is unbounded; unknown non-root
  sessions default to 0, so the ledger fails closed (a plugin reload turns
  in-flight subagents into leaves instead of unbounding them). Keep the
  arg and the header numbers consistent.
- **Structural (hard):** leaf agents deny both `task` and
  `subagent_dispatch`, so the tree bottoms out regardless of prompts. The
  plugin also refuses dispatches beyond `maxDepth` (default 4, matching
  `subagent_depth: 4` in `opencode.json`) by walking the session parent
  chain — necessary because SDK-created sessions skip the task tool's
  built-in depth check.

## Usage

Requires providers authenticated in opencode for the models you keep in the
tier lists (`opencode auth login`).

```bash
git clone git@github.com:changhai0109/opencode-awesome-agents my-project
cd my-project
opencode --agent scheduler
```

Then describe your problem in plain language:

```
Add a --json flag to the CLI: stats output as JSON instead of the table.
Cover it with a test.
```

The scheduler triages, decomposes, and dispatches — each dispatch shows up
as a child session in the TUI so you can inspect what any subagent did. Its
final report lists every dispatch (agent, tier, why), escalations, and the
reviewer verdict. Budget hints in your prompt ("cheap pass", "this is
critical, spend what it takes") shift its tier weighting.

For one-shot use: `opencode run --agent scheduler "your task"`.

To use the roster in an existing project, copy `.opencode/` and
`opencode.json` into it (or merge `subagent_depth` into your existing
config).

## Customizing

- **Tier contents / order:** edit `defaults.tiers` in
  `.opencode/plugin/subagent-dispatcher.ts` (or pass `tiers` via plugin
  options), and keep the mirror table in `.opencode/agent/scheduler.md` in
  sync so the scheduler's guidance matches reality.
- **Timeouts / depth backstop:** `checkTimeoutMs`, `runTimeoutMs`,
  `maxDepth` in the same `defaults` object.
- **Scheduler's own model:** the `model:` line in `scheduler.md`. Must be a
  natively-provided model (see the claude-code caveat above).
- **New roles:** add a markdown file under `.opencode/agent/` with
  `mode: subagent`, no `model:` line, and the appropriate `permission`
  block; then add it to the scheduler's roster table.
