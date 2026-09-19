import type { Part } from "@opencode-ai/sdk"
import { tool, type Plugin, type PluginOptions } from "@opencode-ai/plugin"

type Options = {
  // Hard backstop on tree depth, counted by walking session parents.
  // Dispatches from a session already this deep are refused. Mirrors
  // `subagent_depth` in opencode.json (the built-in check lives in the task
  // tool, which this plugin bypasses — so we enforce it ourselves).
  maxDepth: number
  checkTimeoutMs: number
  runTimeoutMs: number
  // tier name -> pool of "provider/model" ids. A random candidate is
  // picked and probed first; the rest serve as fallbacks in random order.
  tiers: Record<string, string[]>
}

const defaults: Options = {
  maxDepth: 4,
  checkTimeoutMs: 60_000,
  runTimeoutMs: 900_000,
  tiers: {
    // Each tier is a POOL: one entry is picked at random, probed, and the
    // rest serve as fallbacks in random order. claude-code models are
    // excluded entirely: sessions on that provider cannot see custom plugin
    // tools, so a spawn-capable agent landing there could not sub-delegate.
    // NOTE: every id here must resolve via `opencode models`. Local
    // provider names differ from models.dev: Kimi K3 arrives via
    // kimi-code-plan-cn/k3 (not moonshotai/*), MiniMax-M3 via
    // minimax-cn-coding-plan/MiniMax-M3 (not minimax/*).
    // Hardest problems only.
    premium: [
      "kimi-code-plan-cn/k3",
      "openai/gpt-6-astra",
      "openai/gpt-5.6-sol",
    ],
    // Standard implementation, research, and review.
    plus: [
      "openai/gpt-5.6-terra",
      "kimi-code-plan-cn/kimi-for-coding",
    ],
    // Mechanical, fully-specified work and needle queries.
    regular: [
      "openai/gpt-5.6-luna",
      "minimax-cn-coding-plan/MiniMax-M3",
    ],
  },
}

function optionsFrom(value: PluginOptions | undefined): Options {
  const maxDepth = Number(value?.maxDepth ?? defaults.maxDepth)
  const checkTimeoutMs = Number(value?.checkTimeoutMs ?? defaults.checkTimeoutMs)
  const runTimeoutMs = Number(value?.runTimeoutMs ?? defaults.runTimeoutMs)
  return {
    maxDepth: Number.isFinite(maxDepth) && maxDepth > 0 ? maxDepth : defaults.maxDepth,
    checkTimeoutMs:
      Number.isFinite(checkTimeoutMs) && checkTimeoutMs > 0
        ? checkTimeoutMs
        : defaults.checkTimeoutMs,
    runTimeoutMs:
      Number.isFinite(runTimeoutMs) && runTimeoutMs > 0
        ? runTimeoutMs
        : defaults.runTimeoutMs,
    tiers:
      value?.tiers && typeof value.tiers === "object"
        ? (value.tiers as Record<string, string[]>)
        : defaults.tiers,
  }
}

function parseModel(id: string): { providerID: string; modelID: string } | undefined {
  const sep = id.indexOf("/")
  if (sep <= 0 || sep === id.length - 1) return undefined
  return { providerID: id.slice(0, sep), modelID: id.slice(sep + 1) }
}

// Fisher-Yates shuffle of a copy: candidate order within a tier is random,
// so load spreads across providers instead of always hitting the first entry.
function shuffled<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function textFrom(parts: Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const SubagentDispatcher: Plugin = async ({ client, directory }, pluginOptions) => {
  const options = optionsFrom(pluginOptions)

  // Hard spawn-budget ledger: sessionID -> remaining subtree budget granted
  // by its caller. The root session (depth 0, the scheduler) is unbounded
  // and never stored. Unknown non-root sessions default to 0 (fail closed:
  // a caller with no recorded grant cannot spend). Entries are consumed
  // 1-per-child plus the child's own granted budget, mirroring the
  // [scheduler-protocol] header — except here it is enforced, not advisory.
  // Fail-closed on purpose: if this map is ever lost (plugin reload),
  // in-flight subagents become leaves instead of running unbounded.
  const budgets = new Map<string, number>()

  const tierDoc = Object.entries(options.tiers)
    .map(([name, ids]) => `- ${name}: ${ids.join(" > ")}`)
    .join("\n")
  const tierNames = Object.keys(options.tiers)

  return {
    tool: {
      subagent_dispatch: tool({
        description: [
          "Dispatch a task to a named subagent from this project's roster,",
          "SETTING the model it runs on (roster agents carry no pinned",
          "model). The subagent's own prompt and permissions still apply;",
          "only the model is chosen here. Pick a `tier` to use that tier's",
          "model pool, or pass `models` (a \"provider/model\" id list) to",
          "override — either way one candidate is picked AT RANDOM, briefly",
          "probed for usability (via the internal ping agent, unless",
          "`probe: false`), and the rest serve as fallbacks in random order.",
          "This is the",
          "roster's only dispatch tool: the plain task tool is denied",
          "because an unpinned subagent would silently inherit the caller's",
          "model. Spawning is budget-enforced (see `spawn_budget`):",
          "over-budget calls are refused, not queued. Tiers (pools, random",
          "pick):",
          `\n${tierDoc}`,
        ].join(" "),
        args: {
          agent: tool.schema
            .string()
            .describe(
              'Roster subagent to run, e.g. "coder", "reviewer", "explorer".',
            ),
          task: tool.schema
            .string()
            .describe(
              "Complete, self-contained task instruction. Must begin with the [scheduler-protocol] header.",
            ),
          tier: tool.schema
            .string()
            .optional()
            .describe(
              `Tier whose model pool to draw from: ${tierNames.join(", ")}. Ignored when \`models\` is given.`,
            ),
          models: tool.schema
            .array(tool.schema.string())
            .min(1)
            .optional()
            .describe(
              'Explicit "provider/model" id pool; one is picked at random, the rest are fallbacks. Overrides `tier`.',
            ),
          spawn_budget: tool.schema
            .number()
            .int()
            .min(0)
            .optional()
            .describe(
              "How many further subagents THIS child may spawn (its subtree budget, default 0 = leaf). Cost of this call is 1 + spawn_budget against YOUR remaining budget; over-budget calls are refused. Your remaining budget: unbounded if you are the root session, otherwise whatever your caller granted you (check your [scheduler-protocol] header).",
            ),
          probe: tool.schema
            .boolean()
            .optional()
            .describe(
              "Probe the picked model's usability with a tiny ping-agent call before the real run (default true; set false only for endpoints you trust, to save a round-trip).",
            ),
        },
        async execute(args, context) {
          // Enforce the depth backstop ourselves: SDK-created sessions bypass
          // the task tool's built-in subagent_depth check.
          let depth = 0
          let cursor: string | undefined = context.sessionID
          while (cursor && depth <= options.maxDepth) {
            const res: Awaited<ReturnType<typeof client.session.get>> | undefined =
              await client.session
                .get({ path: { id: cursor }, query: { directory } })
                .catch(() => undefined)
            cursor = res?.data?.parentID ?? undefined
            if (cursor) depth++
          }
          if (depth >= options.maxDepth) {
            return {
              output: `Refused: this session is already at depth ${depth}; dispatching would exceed maxDepth ${options.maxDepth}. Do the work yourself or report back to your caller.`,
            }
          }

          const pool =
            args.models && args.models.length > 0
              ? args.models
              : args.tier
                ? options.tiers[args.tier]
                : undefined
          if (!pool || pool.length === 0) {
            return {
              output: `Refused: pass either \`tier\` (one of: ${tierNames.join(", ")}) or a non-empty \`models\` list.`,
            }
          }
          const candidates = shuffled(pool)

          const childBudget = args.spawn_budget ?? 0
          let callerBudget = budgets.get(context.sessionID)
          if (callerBudget === undefined) {
            callerBudget = depth === 0 ? Number.POSITIVE_INFINITY : 0
          }
          const cost = 1 + childBudget
          if (callerBudget < cost) {
            const have = callerBudget === Number.POSITIVE_INFINITY ? "unbounded" : String(callerBudget)
            return {
              output: `Refused: spawn budget exceeded (yours: ${have}, this dispatch costs 1 + child budget ${childBudget} = ${cost}). Do the work yourself, dispatch a leaf (spawn_budget 0), or report back to your caller for a bigger budget.`,
            }
          }
          // Reserve upfront: retries are separate calls and charge again.
          if (callerBudget !== Number.POSITIVE_INFINITY) {
            budgets.set(context.sessionID, callerBudget - cost)
          }

          const failures: string[] = []

          for (const id of candidates) {
            const model = parseModel(id)
            if (!model) {
              failures.push(`${id}: invalid model id (expected "provider/model")`)
              continue
            }

            try {
              if (args.probe ?? true) {
                context.metadata({ title: `Dispatch: probing ${id}` })
                const probe = await client.session.create({
                  query: { directory },
                  body: { parentID: context.sessionID, title: `Probe: ${id}` },
                })
                const probeSession = probe.data
                if (!probeSession) {
                  failures.push(`${id}: probe session create failed`)
                  continue
                }
                const usable = await withTimeout(
                  (async () => {
                    const res = await client.session.prompt({
                      path: { id: probeSession.id },
                      query: { directory },
                      body: {
                        agent: "ping",
                        model,
                        parts: [
                          {
                            type: "text",
                            text: "Reply with exactly: OK. Do not use any tools.",
                          },
                        ],
                      },
                    })
                    if (res.data?.info.error) {
                      throw new Error(JSON.stringify(res.data.info.error))
                    }
                    const reply = textFrom(res.data?.parts ?? [])
                    if (!/^ok\b/i.test(reply)) {
                      throw new Error(`unexpected probe reply: ${reply.slice(0, 80)}`)
                    }
                    return true
                  })(),
                  options.checkTimeoutMs,
                  `probe ${id}`,
                ).catch((error: unknown) => {
                  failures.push(
                    `${id}: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`,
                  )
                  return false
                })
                await client.session
                  .delete({ path: { id: probeSession.id }, query: { directory } })
                  .catch(() => undefined)
                if (!usable) continue
              }

              context.metadata({
                title: `Dispatch: ${args.agent} on ${id}`,
                metadata: { agent: args.agent, model: id },
              })
              const run = await client.session.create({
                query: { directory },
                body: {
                  parentID: context.sessionID,
                  title: `${args.agent} (${id}): ${args.task.slice(0, 60)}`,
                },
              })
              const runSession = run.data
              if (!runSession) throw new Error("failed to create dispatch session")

              const result = await withTimeout(
                client.session.prompt({
                  path: { id: runSession.id },
                  query: { directory },
                  body: {
                    agent: args.agent,
                    model,
                    parts: [{ type: "text", text: args.task }],
                  },
                }),
                options.runTimeoutMs,
                `${args.agent} run on ${id}`,
              )
              const response = result.data
              if (!response) {
                throw new Error(`run failed: ${JSON.stringify(result.error)}`)
              }
              if (response.info.error) {
                throw new Error(`run failed: ${JSON.stringify(response.info.error)}`)
              }
              budgets.set(runSession.id, childBudget)
              return {
                title: `${args.agent} delivered via ${id}`,
                output: `Agent: ${args.agent}\nModel used: ${id}\n\n${textFrom(response.parts)}`,
                metadata: { agent: args.agent, model: id },
              }
            } catch (error) {
              failures.push(
                `${id}: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`,
              )
            }
          }

          return {
            output: `No usable model for agent "${args.agent}". Tried (random order):\n${candidates.join(" -> ")}\n\nFailures:\n${failures.map((f) => `- ${f}`).join("\n")}`,
          }
        },
      }),
    },
  }
}
