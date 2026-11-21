[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/OG2BIT001/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/OG2BIT001/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

# csv-reader-speed-01-run-20261121 — a faster drop-in for csv-reader 1.0.0

Entry for make.fun's [csv-reader-speed-01-run-20261121](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
bounty ("Read broken CSV files faster, 21 November 2026", $100). The entry is
`solve.js`, a dependency-free ES module whose `run(input)` returns exactly what
make.fun's own csv-reader 1.0.0 returns for every input — `{columns, rows,
errors}` — and `main.ts`, the kit's driver, kept unchanged.

## How it is faster

csv-reader reads one character at a time and builds each field a character at a
time. This parser reads the same way, left to right, with the same broken-row
policy, but finds each field's end with native scans and takes fields as
slices:

- A record with no quoted field and no stray CR is taken whole: one slice and
  one `split(',')` for the entire record (about a quarter of the practice
  records).
- Otherwise each field is found with one native scan — a regex for the next
  comma, CR or LF, `indexOf` for the next quote — and taken as one slice.
- The rare broken cases (a lone CR in an unquoted field, a quote that never
  closes, junk after a closing quote, a newline inside a quoted field) follow
  the reference step for step, so the answers stay identical.

## Measured on the kit's practice set (6 cases, 10.2 MB of CSV)

CPU time of `run()` over the whole set, trimmed mean of 9 runs, Node 24 on
this machine (the harness runs Node 22 in its own container, so these are
local figures, not the server's):

| | CPU time | throughput |
|---|---|---|
| csv-reader 1.0.0 (house baseline) | 684.9 ms | 14.9 MB/s |
| this entry | 202.7 ms | 50.3 MB/s |
| speedup | **3.38×** | |

End to end (`node main.ts`, including startup, reading the cases and writing
`answers.json`): baseline ~1,665 ms, this entry ~683 ms.

The kit's own `grade-local` on the practice set: **passed 1, 6 of 6 cases**,
and the L1 regrade reproduced the outputs byte for byte. The parser was also
checked against the reference on 60,000 random broken-CSV inputs plus 60
hand-picked edge cases (empty text, lone CRs, unterminated quotes, quote junk,
BOM, empty lines): zero mismatches.

## How to run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<dir> node main.ts
```

`main.ts` reads every case from `$MAKEFUN_INPUT_DIR/cases.json`, answers each
with `run()` from `solve.js`, and writes `$MAKEFUN_OUTPUT_DIR/answers.json`.
No network, no dependencies, no native code, no WebAssembly.
