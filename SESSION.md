# Session notes — csv-reader-speed-01-run-20261121

Built by OG2BIT, a Muse Spark agent, for Mateo, for make.fun's
csv-reader-speed-01-run-20261121 bounty ("Read broken CSV files faster, 21
November 2026", $100, closes Mon 2026-11-23 03:42 WAT).

## What the entry is

`solve.js` is a faster drop-in for make.fun's own csv-reader 1.0.0, written
from scratch in this session from the kit's reference (`baselines/csv-reader/`
and RULES.txt). Nothing was fetched or copied from GitHub or anywhere else:
the only code taken from the kit is `main.ts`, the kit's own driver, copied
unchanged. `run(input)` returns csv-reader's exact answer — `{columns, rows,
errors}` — for every input, including its broken-row policy (BOM dropped,
stray CRs, unterminated quotes, quote junk, short/long rows, CRLF and lone CR
inside quotes read as LF).

## How it was made fast

1. Read the reference and the rules first, then measured the baseline on the
   practice set: 684.9 ms CPU over the 6 cases (10.2 MB).
2. Micro-benchmarked the scanning strategies: a global regex for the next
   delimiter (56 ms for a bare scan of the set) beat three `indexOf` calls
   (139 ms) and a character loop.
3. Wrote the parser around native scans: a record with no quoted field and no
   stray CR is taken whole with one slice and `split(',')`; otherwise each
   field is found with one regex/indexOf scan and taken as one slice. Rare
   broken cases fall back to the reference's logic step for step.
4. A first version was 2.8× the baseline; the record-level `split` fast path
   took it to 3.38×. A parse-only probe (answer building disabled) showed the
   parser itself runs at 92 ms — over half the remaining time is building and
   keeping the answer structure, which the baseline pays too.

## Verification

- Kit `grade-local` (process driver, worktree): **passed 1, 6 of 6 cases**;
  L1 regrade reproduced the outputs byte for byte.
- `answers.json` from this entry is byte-identical to the baseline's on the
  practice set.
- Fuzzing against the reference: 30,000 random small broken CSVs + 30,000
  structured CSV-shaped texts + 60 hand-picked edge cases — zero mismatches.
- Deterministic: two runs of `main.ts` produce byte-identical outputs.

## Benchmarks (local, Node 24; the harness runs Node 22)

- `run()` CPU, trimmed mean of 9 runs over the practice set: baseline
  684.9 ms (14.9 MB/s), this entry 202.7 ms (50.3 MB/s) — **3.38×**.
- End to end (`node main.ts`): baseline ~1,665 ms, this entry ~683 ms.

## Submission notes for the parent

- The kit is **not** strict_transcripts: `transcripts_required: false` in
  competition.yaml, so the bundle route applies (no sealed recording).
- Repo cap is 1 MiB total; the entry is three files, ~13 KB.
- `main.ts` is the kit's driver verbatim; `solve.js` is the entry.
- The reward needs beating csv-reader at 95% confidence in the final heat;
  locally the entry is 3.38× faster, so it qualifies on speed if the scored
  set behaves like the practice set. Places are by CPU time among the
  contenders, least first.
