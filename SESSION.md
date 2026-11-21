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

## Round 3 optimisation (2026-11-21, after the round-2 resubmission)

The round-2 entry was resubmitted unchanged after a platform grading failure.
This pass makes `solve.js` meaningfully faster again; `main.ts` is still the
kit's driver verbatim. Profile of the practice set (63,696 records): with the
round-2 code only ~19% of records took the `split(',')` path — most records
contain quoted fields (phrases with commas inside quotes), so the per-field
path dominated, and a CPU profile showed ~36% of time in the garbage
collector. Changes, each measured and kept only because it won or tied:

1. **Bounded line parse.** A record that lies on one line and holds no CR is
   now parsed inside its line slice with `indexOf` scans only — one scan to
   each comma for a plain field, one to each closing quote for a quoted field
   — instead of falling back to the regex-per-field path whenever any quote
   appeared. Quote junk after a closing quote is appended as it stands (and
   its error collected), as the reference reads it. Records of this shape:
   43,612 of 63,696; the field-by-field path now sees only 7,917 (multiline
   quoted fields, stray CRs, unterminated quotes).
2. **No per-field regex in the slow path.** The next-delimiter scan is now
   `indexOf` for comma/LF plus a binary search in a list of every CR position
   gathered in one pass at the start of `run()` — no match object allocated
   per field, and no scan that can roam in a text whose CRs are rare.
3. **Cheaper quoted-span bookkeeping.** Line breaks inside a quoted span are
   counted with `indexOf` loops instead of a `match()` array; the CR-to-LF
   rewrite only runs when the span actually holds a CR.
4. **Less garbage.** The bounded parse reports through one reused scratch
   object, and its error list is allocated only when a quote_junk is met.

Verification after the changes:

- Kit `grade-local` (process driver, worktree): **passed 1, 6 of 6 cases**;
  L1 regrade reproduced the outputs byte for byte.
- Answers identical to the baseline's `run()` on all 6 practice cases.
- Fuzzing against the reference: 30,000 random small broken CSVs + 30,000
  structured CSV-shaped texts + 98 hand-picked edge cases (seeded, so
  reproducible) — **zero mismatches**.
- Deterministic: two runs of `main.ts` produce byte-identical outputs.

Benchmarks (local, Node 24, this VM is shared and noisy, so figures are
trimmed means of interleaved A/B runs over the practice set, `run()` CPU):

- Round-2 entry: ~162–210 ms per paired run; this entry: ~133–170 ms —
  consistently **~24% faster** than round 2 across five paired comparisons
  (ratios 0.68–0.82, median 0.76).
- Baseline csv-reader 1.0.0 in the same runs: ~676–706 ms, so this entry is
  roughly **4.3× the baseline** (round 2 was 3.38× on a quieter machine).
- End to end (`node main.ts`, wall, median of 3): this entry ~1.36 s,
  baseline ~2.46 s.

## Submission notes for the parent

- The kit is **not** strict_transcripts: `transcripts_required: false` in
  competition.yaml, so the bundle route applies (no sealed recording).
- Repo cap is 1 MiB total; the entry is three files, ~13 KB.
- `main.ts` is the kit's driver verbatim; `solve.js` is the entry.
- The reward needs beating csv-reader at 95% confidence in the final heat;
  locally the entry is 3.38× faster, so it qualifies on speed if the scored
  set behaves like the practice set. Places are by CPU time among the
  contenders, least first.
