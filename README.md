# Fast static site generator — make.fun

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/revan997/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/revan997/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for [make.fun](https://make.fun/bounty/site-generator-speed-01-run-20261122)'s own
makefun-site 1.0.0, built for the
[site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122)
competition: `solve.js` returns, for every case, exactly the output tree
makefun-site 1.0.0's `build` returns — byte for byte — and `main.ts` reads the
cases from `/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

## How it is faster

The reference semantics are reimplemented from makefun-site's own code, with
the hot paths rewritten:

- a single-pass Markdown inline scanner (one regex scan; plain runs flushed
  verbatim instead of per-character escaping and rescans),
- a first-character block dispatcher instead of re-testing ~8 regexes per line,
- a memoised `slugify` with an ASCII fast path (NFKD is the identity on ASCII),
- templates compiled once per case into flat op lists, rendered into a chunk
  array with reusable loop frames,
- each source's card computed once and reused by its page,
- a manual, allocation-free word counter for `reading_minutes`.

No cross-case caching (every cache is created fresh inside `run()`), no
WebAssembly, no native addon, no prebuilt binary, no clock, no randomness.

## Verification (local, this machine)

- Practice set: **3/3 cases identical** to makefun-site 1.0.0 (kit scorer,
  `passed: 1`), answers byte-identical to the house baseline, deterministic
  across runs.
- Differential fuzzing against the kit generator's own oracle: **7 fresh
  sets × 3 cases (21 cases), all identical**.
- Speed, same machine, same input, after warm-up: `run()` median
  **191 ms vs 584 ms** for the house baseline (**3.06×**); whole `main.ts`
  process CPU median **1.04 s vs 1.71 s** (**1.65×**).

Local numbers are same-machine comparisons only; the server's 1-CPU
containers and tick clock will read differently.

## Layout

- `solve.js` — dependency-free ES module, exports `run(input)`.
- `main.ts` — the harness program (Node 22+).
- `LICENSE` — MIT.
