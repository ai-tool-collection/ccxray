# #149 Shape/Glyph Channel — Verification Report

Date: 2026-07-06
Branch: `main` (post-merge + autoresearch redesign)

## What shipped

A redundant non-color identity channel (SVG-drawn glyphs) for workflow lanes.
Each lane carries a `(color, glyph)` pair. Combined pool: 7 colors × 7 shapes + 1 pinned = **50 unique combos**.

## Design process

Autoresearch: 3 candidate pools → 3 evaluations → all <9/10 → root cause analysis → 3 design paths (shapes-only / colors-only / hybrid) → measured color expansion (Oklab + CVD) → final proposal scored 8.8/10 (combined 9/10). User accepted Plan B.

Priority order: **無意義 > 辨識度 > 一致性** (zero meaning > distinguishability > consistency)

## Color palette (7 hashed + 1 pinned)

| slot | hex | family | status |
|------|-----|--------|--------|
| main | #42a3fd | blue | pinned |
| 0 | #ffdbaa | peach | existing |
| 1 | #dc7d96 | rose | existing |
| 2 | #a1a716 | olive | existing |
| 3 | #45f8ef | cyan | existing |
| 4 | #d1d843 | lime | existing |
| 5 | #d742a5 | magenta | **NEW** — CVD-safe (Oklab min 127) |
| 6 | #4242d7 | indigo | **NEW** — CVD-safe (Oklab min 116) |

Inter-palette worst: #ffdbaa vs #d1d843 (Oklab 129 normal, 93 CVD) — pre-existing.
New colors clear all 9 reserved colors and pass deuteranopia simulation.

## Glyph pool (7 hashed + 1 pinned, ALL filled)

| slot | name | shape | silhouette class |
|------|------|-------|-----------------|
| — | circle | filled circle ● | round |
| 0 | square | filled square ■ | 4-corner axis-aligned |
| 1 | triangleUp | filled triangle ▲ | 3-corner pointed |
| 2 | diamond | filled diamond ◆ | 4-corner rotated |
| 3 | plus | filled thick cross ✚ | non-convex 12-vertex polygon |
| 4 | semicircle | filled D-shape ⌓ | hybrid: curve + flat edge |
| 5 | trapezoid | filled trapezoid ⯃ | tapered 4-sided |
| 6 | parallelogram | filled slanted rect ▰ | asymmetric 4-sided |

Rejected shapes: star (★ conflicts with favorite UI), cross/✕ (close/delete semantics), hollow variants (create paired grouping), hexagon (≈ circle at 10px), triDown (≈ triUp flipped).

## Weakest pair

trapezoid ↔ triangleUp: both taper upward, but trapezoid has flat top (~2-3px distinction at 10px). Marginal for shape-only, but combined with color channel probability of same-color is 1/7 → combined score 9/10.

## Unit tests

| test | status |
|------|--------|
| `wfLaneShape` + `wfComputeLaneStyles` + `WF_LANE_GLYPHS` exposed | ✓ |
| main pinned glyph = circle | ✓ |
| same lane.key → same glyph (stable identity) | ✓ |
| `wfComputeLaneStyles` returns `{color, glyph}` | ✓ |
| 11 concurrent lanes → 11 distinct (color,glyph) pairs | ✓ |
| adversarial 21 lanes → all distinct | ✓ |
| 50-lane capacity (49 hashed + 1 main) → 50 unique pairs | ✓ |
| lane and card resolve same glyph | ✓ |
| all 8 glyphs render valid SVG | ✓ |
| inline `<svg>` HTML output | ✓ |

## Codex reviews

**Round 1**: found Cartesian probe bug (glyph-only), fixed with two-level probe + h>>>16.
**Round 2**: 0 blocking, 4 advisory (fallback hash fixed, rest YAGNI).
