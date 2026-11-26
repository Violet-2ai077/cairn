# Task attribution and context quality

## Reproduce

| Command | What it establishes |
| --- | --- |
| `node scripts/eval-reliability.mjs` | Offline JSON report: ranked candidates, actual Hub turn receipts, preference review writes on a temporary Hub, and facts visible in five synthetic context layouts. |
| `node scripts/eval-reliability.mjs --live` | The **configured** OpenAI-compatible worker endpoint is called with synthetic prompts. Set `CAIRN_MODEL`, `CAIRN_API_KEY` (or `DEEPSEEK_API_KEY`) and, if needed, `CAIRN_API_BASE`. No production task content, tools, semantic retries or real workspace writes. May incur provider charges. |
| `node --test test/hub-quality.node-test.mjs` | Regression assertions for the published cases, incl. no authority from expansion and no recovery after journal tampering. |
| `node scripts/smoke-dsh.mjs /path/to/dsh/lib/bin.js --separate-session-only` | Actual installed headless dsh with an isolated local scripted provider. A tool-using task continues in its original session; a switch makes **no business request**; the new task runs in a fresh session. |

Keep the JSON, corpus revision and model identifier alongside an experiment. No provider is called by default. `live: null`, unreported provider usage, no observed human recovery rate and a measured zero are different results. Fixture coverage is not an estimate of production prevalence. Token usage is provider-reported; prompt bytes are not tokens or prices. Shortlist timing covers CPU retrieval, not disk or model latency; the live router timing covers the whole route. No credentials or raw HTTP requests are printed.

## Dormant retrieval

At 20, 50, 100, 500 and 1,000 dormant metadata rows, the fixture has eight uniquely labelled requests plus duplicate-title, undirected and new-topic controls. It includes an English invoice title queried as “继续做账单核对”, the reverse language direction, same-name tasks in two projects, a paraphrase and a reference to a historical decision. The larger catalogs add deterministic, similar technical titles, not additional independently labelled user queries. Every size runs the same scorer twice with only the bilingual term expansion changed. This measures retrieval, not short marker capacity.

The checked-in cases yielded **2/8 → 6/8 Recall@5** (also @10 and ranking top-1). Both the printer paraphrase and the historical Ghostscript reference still miss. A dozen subject aliases improve this particular failure without a vector service, whole-history scan, model call, or authority to bind. Positive scores merely select cards for the existing semantic router. Seek a user choice for an unresolved continuation. Generic follow-ups and frozen tasks do not get an automatic match. Do not interpret the gain on this small development set as general multilingual accuracy.

The live run adds one hot distractor and a dormant task with the Ghostscript decision in its saved thread. It runs the normal two-stage router on 20 tasks, reports latency, usage, decisions, errors and false matches. Returning a single match for an ambiguous oracle is a false binding. Here “binding” is the **router's recommendation**; it does not run or archive business turns. Add held-out paraphrases, projects and languages before changing the routing policy.

## Marker A/B: verified bytes are not verified intent

A uses the actual scoped turn runtime, final marker parser, and terminal receipts on a temporary Hub. B **only counts** the outcome if a locked scope plus completed native journal and matching input/output digest could substitute for a missing marker. Neither variant accepts disagreement, unresolved/malformed markers, interruption or an altered journal. B does not write archives or change the installed host. Manual eligibility is reported separately from actual manual operations.

The nine intentionally adversarial turns yield 2 archives in A, 4 shadow admissions in B. The extra two include one wrong-scope negative control. Agreement also cannot rescue a host and model that both point at the wrong task. These are labelled counterexamples, not measured deployment error rates. **Keep the short marker, fail closed on mismatch and retain explicit human recovery.** The optional model run checks actual production-format tail-marker emission in Chinese and English; it is not a live user-intent oracle.

## Preference extraction

The fixed intake cases include durable, one-off, conditional, quoted/reported, negative, repeated, mixed-language, ambiguous-scope, two-scope and changed preferences. Count a scope-ambiguous draft as correct only when both choices are offered; no defaulting to User. Count missing expected items as wrong in scope accuracy. One indirect stylistic preference deliberately remains a miss. The deterministic baseline is **0/6** false-positive negative cases, **1/8** missed preference items, **7/8** correct scope results. The duplicate and changed-value probes go through the real protected review store: one explicit test confirmation commits; neither a repeat nor a conflicting change overwrites the active value. Each of those probes has denominator one. The optional live run adds drafted keys and exact labelled option checks, not LLM-supplied approval.

## Opt-in fresh sessions for different tasks

For the Hub adapter:

```yaml
autopilot:
  enabled: true
  midSessionSwitch:
    enabled: true
    historyMode: separate-session
```

Default `native` keeps dsh's normal same-session switching. In `separate-session`, the business model receives native history only when the session has no inherited prefix and every previous numbered turn has a matching confirmed archive for the selected task. Switching a bound task, an unknown session lineage, or any missing, interrupted, manually recovered or unassigned prior turn requires a **new dsh session**. Do not fork/resume the old one. In the new session type e.g. `继续任务 #2，请检查该任务上次失败的测试`. The same task may keep its session and its unmodified tool-call/result pairs. A declined switch is itself an unassigned turn; continuing either task afterward requires a fresh session, by design. Use explicit task IDs in headless fresh sessions if a text menu would create an unassigned turn. Cost: the strict check reads earlier turn receipts; the default does not.

The strict answer snapshot also omits other tasks' hot-catalog titles: generated titles can contain part of the previous user's request. The headless smoke checks the **whole provider request** for a previous-task witness, not just the checkout. This policy does **not** isolate files, tools, model endpoints, shared ledgers or host configuration; use independent execution environments and permissions for confidentiality. It does not sanitize what the user explicitly brings into a new session. The auxiliary router can still see candidate previews. There is no native-history filtering feature in this release.

The conflicting-facts study compares native history, ordinary switch, a full-ledger prompt, a fresh session, and a synthetic task-only projection in both A→B and B→A directions in live mode. The prompts label engine, authorized path, permitted tool and failing test. Offline exposure counts are **4/4** stale facts in each mixed-history layout, **0/4** in fresh/projected layouts. Live scoring checks exact mentions of current/stale facts in the answer and token usage; these are **stated choices**, not actual cross-project file effects or executed tool calls. The projected layout is experimental, not an installed request filter. Use the real dsh smoke for host enforcement and independent permission tests for tool isolation.
