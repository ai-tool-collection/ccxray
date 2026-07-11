# 0009 — Sequential interleave: convId bracketing + msgCount dip stitching

- Status: Accepted
- Date: 2026-07-11
- Related: #230 / #229 / #232 (ADR 0008), #222

## Context

ADR 0008's temporal-overlap split only catches **parallel** agents — physics
proves concurrency. A *sequential* teammate (dispatched while main idles,
zero time overlap) or a fork's between-main-turns continuation leaves no
overlap footprint. Real-data audit after #232 (2026-07-11, 439 sessions):
session `4b15c248` still had 12 msgCount non-monotonic residues and five
models ping-ponging inside its main lane (sequential dev teammates);
`86949194` had exactly one residue (55→51 — a fork turn that started 1s
after main's turn ended); `a7fef8a8` had 7 Opus fan-out turns inside a
Fable-5 main.

Two wire signals remain when overlap is blind, each with a failure mode the
other covers:

- **convId** (messages[0] hash): main's convId only moves forward —
  compaction replaces messages[0] with a summary and never goes back;
  /resume, retry, and rewind all keep messages[0]. So *conv A resuming
  after foreign-conv runs* proves those runs were excursions. But a fork
  shares the parent's convId — convId alone is blind to exactly the #229
  warning case.
- **msgCount monotonicity**: a serial conversation's msgCount never drops
  outside compaction. But rewind/edit (`7e1d9272`'s 540→493, then steady
  +2 regrowth) is a legal main-lane drop, and fan-out first-turns get
  *mislabeled* `isCompacted` (big msg+token drop vs. the previous main
  turn — `a7fef8a8` evidence), so neither "any drop splits" nor "trust
  isCompacted" works.

## Decision

A shared **sequential-interleave tracker** (`wfCreateSeqTracker` /
`wfSeqFeedSplit` / `wfSeqFeedMain` in `workflow-timeline.js`) implements
both rules once; `wfInferLanes` (batch), `wfAddEntry` (live), and
`entry-rendering.js` `addEntry()` each hold an instance fed the same
per-turn signals — the ADR 0005 shape, like `AGENT_KEY_UNRELIABLE`:

- **R1 — convId run bracketing with trunk-advance**: main-candidate turns
  form convId runs in **start order** — the tracker keeps its candidate
  list sorted by `(receivedAt, id)` internally, because entries arrive in
  completion order: a nested turn can finish before the longer turn that
  started first, and arrival-order runs would let a foreign-conv turn
  arriving first become the trunk, wedging every bracket open for the rest
  of the session (codex P2, round 1). Foreign-conv runs are *provisionally
  main*; when the trunk conv reappears, everything in between is an
  excursion (retro-moved out). A trunk that never returns = compaction —
  the pending runs stay main. `isCompacted` is never consulted.
- **R2 — same-conv msgCount dip stitching**: a turn whose msgCount drops
  below its conv's previous main turn is an excursion **iff** it continues
  a frontier already split out of main (same conv, `tailMsg ≤ msg ≤
  tailMsg + 2`, starting at/after the tail ends — Δ=2 is one exchange, the
  natural msgCount step; owner-approved 2026-07-11). No frontier → rewind/
  edit → stays main. Tail points are tracked **per conversation and
  append-only** (`Map(convId → [point…])`, one point per split turn, no
  cap, never merged): a shared FIFO cap would evict still-active convs'
  evidence (codex P2, round 3), and merging a "continuation" split into
  an earlier point erases the historical branch point that another
  concurrent track's sequential continuation still needs — the merge
  variant regressed the 439-session re-audit from 3 to 8 jumpreturn
  residues (2026-07-11). Only an R2 stitch advances a point, because the
  dip consumed it. Memory is O(split turns) per session. Points **retire
  after 15 minutes** (`WF_SEQ_FRONTIER_TTL_MS`, judged at lookup — never
  removed from the Map): measured over the 439-session audit, real stitch
  gaps are p50=22s / p90=3min and every verified-good stitch is ≤2min,
  while all 6 sampled >10min fits were edit/rewind shapes — 15min keeps
  ~30× headroom yet structurally closes hour-scale rewind collisions with
  stale branch points (codex P2 round 4; owner-approved 2026-07-11).
- **Batch = live by construction**: the tracker re-runs the full trunk walk
  on every feed, so the live path equals the batch pass on every prefix.
  In `wfInferLanes` the overlap sweep (ADR 0008) and the seq pass iterate
  to a fixpoint: excursing a turn re-runs the sweep without it, so a main
  turn that only overlapped an excursion is re-admitted — otherwise a
  batch rebuild would disagree with the live path, which never saw the
  excursion in main (round-4-bug shape, cross-pass edition).
- Turns without `convId` or `receivedAt` are inert: never boundaries,
  never moved (legacy data, codex sessions).

## Consequences

**Good**: real-data replay (439 sessions): 1,018 turns leave main lanes
across 38 sessions; `4b15c248` residues 12→0 (all sonnet dev-agent turns
out); `86949194` 55→51 → 0; `a7fef8a8` main becomes pure Fable 5;
`7e1d9272` (767-turn healthy session, one compaction, two rewinds)
unchanged. Compaction, rewind, and legacy no-convId data are structurally
exempt, not threshold-exempt.

**Bad — known misses (accepted, owner decision 2026-07-11)**: a fully
sequential same-conv fork with no split-out frontier is invisible (4
corpus residues, all pre-#232 sessions, "dip then discontinuous jump
back" shape). Deliberately not chased: the lookahead rule that would catch
them risks false-splitting rewinds (queued user messages also jump >4) —
precision is a separate acceptance axis (see the isRetry follow-up issue).
Root fix remains #222's wire-level identity ask.

**Bad — provisional-main window**: live, a teammate run sits in main until
the trunk conv returns (retro-move on bracket close; the turn list
renumbers via `_seqRetroFlip`). Same acceptance as #229's reverse
retro-move.

**Boundary — live reverse-overlap stays ADR 0008 territory**: the turn
list's forward-only overlap check still records an early-arriving nested
*same-conv* turn as main until the next batch rebuild (the sorted sweep is
the authoritative resolver — pre-existing gap, unchanged here). What the
sorted candidate list fixes is the seq tracker's own order sensitivity:
arrival order can no longer poison the trunk, and when the nested
early-arriver is a *foreign* conv, the R1 bracket close now also heals the
turn list live via retro-flip. One case needs more than the sorted list:
an earlier-starting turn arriving after an R1 bracket already **closed**
can overturn the closed excursion — the trunk itself changes (B0-A-B-A
truth discovered late), and the closed turns have left the tracker list,
so no incremental step can reopen them. Both files converge symmetrically
on that flag: the swimlane falls back to a full `wfBuildState` rebuild
(`_wfSeqRebuild`, view state migrated — codex P2 round 5), and the turn
list recomputes its session's seq layer (`_seqRecomputeSession`: fresh
tracker, `(receivedAt, id)`-sorted replay, diff-and-apply of seq-caused
flips in BOTH directions via `_seqFlipped` marks — codex P2 round 6;
agentKey/overlap/raw classifications are never touched). Bounded — only
overlap-inversion arrivals trigger either. The remaining forward-only
boundary is the overlap spans check alone (pre-existing, unchanged).

**Bad — rewind-across-compaction**: /rewind restoring a pre-compaction
checkpoint makes the old conv "return", so the compacted run in between
would split as an excursion. Rare; rendered lanes are at least visually
honest ("a discarded branch").

## Alternatives considered

**Pure msgCount monotonicity (no convId structure)**: rejected —
`a7fef8a8`'s fan-out first-turns carry a false `isCompacted`, so a
msgCount-only rule either trusts the flag (misses the whole fan-out) or
ignores it (splits every real compaction).

**Pure convId bracketing (the original #230 sketch)**: rejected — forks
share the parent's convId (#229's warning); the `86949194` 55→51 fixture
is invisible to it.

**Lookahead jump-return rule to catch the 4 remaining residues**: rejected
for recall-vs-precision reasons above; documented as known limitation.
