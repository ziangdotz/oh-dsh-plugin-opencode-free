# OpenCode memory analysis — 2026-11-08

Machine: Windows, 32,244 MiB usable physical memory. OpenCode 2.2.5,
Node 24.22.1. Production plugin settings and user config were not modified.
Only ephemeral owned servers on random loopback ports were started; all were
closed after measurement. No model inference or session creation was performed.

## Method and scope

`tools/memory-probe.mjs` measures the complete owned process tree with Windows
WorkingSet64 and PrivateMemorySize64. Working set sums include shared pages more
than once; private bytes measure private committed memory, not physical residency.
The denominator for the percentages below is physical memory, so percentages use
working set only. These are short idle samples, not stress-test peaks, hard limits,
or statistically established minima. No forced working-set trimming was used.

Two stages: startup readiness via unauthenticated `/api/model` (401), then one
Basic-authenticated `/api/model` request (200). Post-catalog samples were taken
after 5 and 20 seconds of sleep; process enumeration adds a small time offset.
Reading the catalog initializes substantially more code/state than readiness.

## Results (MiB, complete tree)

| Launch | Startup idle WS | 5 s after catalog WS | 20 s after catalog WS | Private at 20 s |
|---|---:|---:|---:|---:|
| NVM command wrapper, initial run | 174.82 | 293.93 | not sampled | not sampled |
| Direct native binary, initial run | 161.21 | 281.52 | not sampled | not sampled |
| Direct native binary, repeat | 159.80 | 269.13 | 250.25 | 407.26 |
| Direct native + BUN_OPTIONS=--smol, repeat | 160.58 | 268.84 | 249.85 | 407.94 |
| Direct native + lean config / empty cwd | 160.46 | 265.41 | 247.24 | 423.29 |

An initial `--smol` run reached 378.04 MiB after catalog loading. The repeat did
not reproduce that value. Thus neither improvement nor regression is established
for this flag on the installed executable. The repeated comparison shows no
material reduction at 20 seconds; do not enable it solely on expectation.

Lean experiment: empty temporary working directory, inline `lsp:false`,
`enabled_providers:["opencode"]`, `autoupdate:false`, `snapshot:false`, plus
`OPENCODE_DISABLE_PROJECT_CONFIG=true` and
`OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER=true`. Config is merged by OpenCode;
this was not full isolation of global plugins or credentials. Compatibility and
actual enforcement of every legacy/experimental flag on v2 were not independently
verified. This experiment therefore shows the measured effect of these overrides,
not the minimum attainable with a rebuilt, isolated OpenCode distribution.

At 20 seconds the native process alone used 228.16 MiB (ordinary) / 225.11 MiB
(lean); the C# owner used about 14.3 MiB and conhost about 7.8 MiB. The NVM wrapper
also keeps roughly 14.8 MiB across cmd and an opencode launcher in these samples.
The main runtime, rather than plugin buffers, dominates the idle baseline.

## Feasible target

For the existing full OpenCode runtime, target approximately 230–250 MiB for the
whole tree after initialization and while idle: 0.71–0.78% of this machine's
physical memory. 247–250 MiB is observed with direct launch. The lower end is an
engineering estimate, assuming a native owner replaces the CLR owner and possibly
removes console overhead; it has not been implemented or measured.

An idle target below 100 MiB (0.31%) is unsupported by these measurements. Reaching
it would likely require investigation and changes inside OpenCode: selective or
lazy provider/catalog loading, fewer eagerly loaded modules, and runtime/build
changes. No minimum for successful generation, long histories, or tool execution
can be inferred from this non-inference workload. Pinning models and skipping a
full catalog is worth testing with real turns before claiming further savings.
The existing queue and byte limits constrain plugin-controlled resources, not the
whole Bun heap or descendant tool processes.

## References

- https://bun.sh/docs/runtime#bun-run-smol
- https://bun.sh/docs/compiler/executables
- https://docs.opencode.ai/docs/config/
- https://docs.opencode.ai/docs/lsp/
