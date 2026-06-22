# Workflow View Design Spec

Issue: #91 — Session timeline can't express dynamic agent workflows

## Problems to Solve

### Structure (1-5)
1. **Parent-child severed** — `inferParentSession()` merges subagent into parent session; the spawn edge is lost
2. **Parallelism invisible** — 4 parallel forks appear as a single `Agent×4` line item
3. **Fan-in invisible** — subagent results flowing back to orchestrator's next turn is not shown
4. **Multi-layer spawn** — orchestrator → fork → fork (eval batch pattern); prototype only handles one layer
5. **Heterogeneous agent types** — `Explore`, `fork`, `codex:codex-rescue` all shown as generic "subagent"

### Lifecycle (6-8)
6. **Task lifecycle invisible** — TaskCreate/Update/Stop scattered as individual tool calls; no create→running→done view
7. **Subagent success/failure invisible** — no lane-level pass/fail indicator
8. **Duration comparison impossible** — linear list can't show which parallel agent is the bottleneck

### Navigation (9-10)
9. **Spawn point not clickable** — `Agent×4` shows input JSON but can't jump to the spawned session
10. **No reverse navigation** — inside a subagent session, can't trace back to spawning orchestrator turn

### Resources (11-12)
11. **Context window state invisible** — fill level, compaction events, approaching-limit warnings not shown
12. **Model type + context window size invisible** — different agents use different models with different limits

## Constraints

- **Zero dependencies** — ccxray ships no build step, no npm deps beyond Node.js
- **No data-layer rewrite** — edges (spawn, parent, parallelism, timing) are already captured; this is a new view consuming existing data
- **Must coexist with existing UI** — replaces the Turns column only; Projects, Sessions, topbar, and detail pane format are preserved
- **Performance** — must handle 471-turn sessions (fable-161) smoothly
- **Dark theme** — bg #0d1117, surface #161b22, border #30363d, text #e6edf3, dim #8b949e

## Design Decisions

### Rejected approaches (prototyped and evaluated)

| Approach | Why rejected |
|----------|-------------|
| **A: Swimlane Flow** (horizontal bars, spawn/fan-in curves) | Bars pile up at 346+ turns; too much ink per turn |
| **B: Git Graph** (vertical topology, colored branch lines) | Branch lines become spaghetti at 6+ lanes; vertical layout wastes horizontal space |
| **C: Heatmap Swim** (context-colored bars) | Same density problem as A; color overload |
| **Progressive disclosure** (collapse/expand teams) | Tufte: "you're hiding data, not designing it"; adds affordance problems |

### Chosen: Tufte Sparkline Small Multiples + Existing ccxray Detail

> "346 turns is not too much information — your pixel allocation is too wasteful."

**Principle:** Show all data at once using high density. Let the eye do pattern recognition instead of making the user click to reveal hidden state.

## Layout

```
┌─ Topbar (unchanged) ──────────────────────────────────────────────────────┐
│ ● ccxray  Dashboard  Usage  System Prompt ●                               │
│ root › ccxray › session: 4ff947ed › #460 › timeline                       │
│                                        ◐ ████░░ 63.8% · 1h49m ▲ Slow    │
├──────────┬───────────────┬────────────────────────────────────────────────┤
│ PROJECTS │ SESSIONS      │ WORKFLOW TIMELINE (extends to right edge)      │
│          │               │                                                │
│ (full    │ (full         │  0m    10m    20m    30m    40m    50m         │
│  height) │  height)      │                                                │
│          │               │  main ▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕ │
│ ● ccxray │ ● 4ff947ed    │       ▁▂▃▃▃▅▅▆▆▇▇██████                      │
│   10 sess│   opus-4-6    │                                                │
│          │   455t $54.70  │ ▶rout ▕▕▕▕▕▕░░▕▕            OVERVIEW + - ⟲  │
│          │               │  llm  ▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕      ┌──────────┐    │
│          │ ○ 1085045f    │  stat ▕▕▕▕▕▕▕▕▕              │▕▕▕▕▕▕▕▕▕│    │
│          │   opus-4-8    │  time ▕▕▕▕▕                   │ ▕▕       │    │
│          │   154t $26.42 │  flex ▕▕▕▕▕                   └──────────┘    │
│          │               │  supa ▕▕▕▕▕▕                                  │
│          │ ○ 1bd91918    │                                                │
│          │   opus-4-6    │         (no separator — continuous flow)       │
│          │   72t $2.58   │                                                │
│          │               │  ┌─ Agent Card (240px) ─┐ ┌─ Timeline Steps ─┐│
│          │ ○ ea47fafd    │  │ spec-routing       ★ │ │ TIMELINE          ││
│          │   opus-4-6    │  │ fable-5 19t 1.7m     │ │ ● spec-routing   ││
│          │   46t $4.49   │  │ general-purpose      │ │ 19 steps · 0✗    ││
│          │               │  │                      │ │                   ││
│          │ ○ f1504e19    │  │ 39.7% (397K/1000K)  │ │ #44               ││
│          │   opus-4-8    │  │ peak 39.7%           │ │  Agent×6 ⑂6      ││
│          │   125t $21.45 │  │ ┌──────────────────┐ │ │  spec-routing... ││
│          │               │  │ │╌╌╌╌╌╌╌╌╌╌╌╌83.5%│ │ │                   ││
│          │ ○ a9c6a2ac    │  │ │══════════════ 40% │ │ │ ★ #45            ││
│          │   opus-4-6    │  │ │   ╱──╲           │ │ │  ┌ Bash  ✓ local ││
│          │   64t $8.01   │  │ │▁▁╱    ╲▁▁▁▁▁▁▁▁▁│ │ │  └ Bash  ✓ local ││
│          │               │  │ └──────────────────┘ │ │                   ││
│          │ ○ 527eba79    │  │                      │ │ #46               ││
│          │   opus-4-8    │  │ CACHE                │ │  🤖 thinking      ││
│          │   34t $3.86   │  │ 93.1% hit            │ │                   ││
│          │               │  │ ▓▓▓▓▓▓▓█▓▓▓▓▓▓▓▓▓▓ │ │▶★ #51             ││
│          │ ○ b29e111b    │  │                      │ │  ┌ Read×4  ✓     ││
│          │   opus-4-8    │  │ COST                 │ │                   ││
│          │   290t $56.21 │  │ $0.738 avg $0.11/t   │ │ #52               ││
│          │               │  │ ▒▒ ▒▒▒▒▒▒ ▒▒ ▒████  │ │  ┌ Read×6  ✓     ││
│          │               │  │                      │ │                   ││
│          │               │  │ ● Timeline 19     › │ │ #53               ││
│          │               │  │ CONTEXT              │ │  ┌ Read×14 ✓     ││
│          │               │  │  ● System  6.4K   › │ │                   ││
│          │               │  │  ● Core    34t     › │ │                   ││
│          │               │  │  ● MCP     91t     › │ │                   ││
│          │               │  │  ● Skills  2/251   › │ │                   ││
│          │               │  │ ANALYSIS             │ │                   ││
│          │               │  │  💰 Cost          › │ │                   ││
│          │               │  │ RAW                  │ │                   ││
│          │               │  │  Request           › │ │                   ││
│          │               │  │  Events 14         › │ │                   ││
│          │               │  └──────────────────────┘ └───────────────────┘│
│          │               │  ↑↓ steps  Esc exit  f ★ star  n next star    │
└──────────┴───────────────┴────────────────────────────────────────────────┘
```

### Key layout rules

1. **Topbar** — unchanged from current ccxray (branding, nav tabs, breadcrumb, quota ticker)
2. **Projects column** (160px) — full window height, scrollable independently
3. **Sessions column** (200px) — full window height, scrollable independently
4. **Right area** — everything right of Sessions extends to window edge
5. **No separator** between Workflow Timeline and Detail area — continuous vertical flow
6. **Lane label width = Agent Card width** (240px) — visually one continuous left column through timeline and detail
7. **Star (★)** appears before step number in Timeline Steps, not after

## Interaction Flow

### Session Selection
1. User clicks a session in the Sessions column (not tabs — sessions are in the column)
2. Workflow Timeline renders with all agent lanes (sparkline small multiples)
3. Main agent lane auto-selected; Agent Card + Timeline Steps appear below
4. No separator line between timeline and detail — they are one continuous vertical space

### Lane Selection
| Action | Result |
|--------|--------|
| Click lane label (240px area) | Select agent → Agent Card shows agent summary, Timeline Steps shows all turns |
| Click specific turn bar | Select agent + scroll Timeline Steps to that turn |
| Click different lane | Switch Agent Card + Timeline Steps to new agent |
| Esc | If zoomed → reset zoom. If not → back to main agent |
| ← main button | Return to main agent (never blank) |

### Timeline Interaction
| Action | Result |
|--------|--------|
| Drag | Pan (shift visible time range) |
| Scroll wheel | Zoom centered on cursor |
| Double-click | Reset to full session view |
| Hover turn bar | Tooltip: turn#, model, ctx%, tools, duration |

### Minimap (always visible, bottom-right of timeline area)
- Shows full session at reduced scale
- Blue rectangle = current viewport
- Dimmed area outside viewport
- Click/drag minimap = pan viewport
- `+` / `−` / `⟲` buttons for zoom in / out / reset
- Bar heights proportional to lane density

### Agent Card (240px, left side of detail area)

**Agent summary** (default state):
- Agent name, model badge, turn count, duration, type (orchestrator/fork/general/codex)
- ★ star toggle (stars the entire agent; reflected on lane label)
- Context minimap with threshold lines:
  - 40% green dashed — smart zone ceiling
  - 83.5% red dashed — autocompact threshold (⚠ warning if peak exceeds)
- Cache hit rate + inline bar chart (yellow bars for < 50% cache hit turns)
- Cost total + avg/turn + inline bar chart
- All three charts share X axis (turn index), clickable → select turn, blue cursor line pierces all three
- Navigation items: Timeline (step count), Context (System/Core/MCP/Skills), Analysis (Cost), RAW (Request/Events) — with › chevrons
- Tools summary, Tokens summary, Spawns count
- ← main button (for subagent cards)

### Timeline Steps (right side of detail area)
- Step rows: ★ star → #num → model badge → tool chips → ctx% → duration
- ★ appears **before** the step number (leftmost element)
- Tool group brackets (┌ │ └)
- Selected step highlighted with blue left border
- Scrollable; auto-scrolls to selected turn
- Keyboard nav: ↑↓/jk steps, f star, n next star, E prev error, s next skill, a next subagent

### Star Functionality
| Target | How | Where visible |
|--------|-----|---------------|
| Turn | ★ on step row (before #num) | Timeline sparkline shows ▲ marker at turn position |
| Agent | ★ on Agent Card header | Lane label shows ★ |

## Sparkline Timeline Visual Encoding

Each agent lane = two thin rows:

**Row 1 — Turn bars:**
- Tiny rectangles, width ∝ elapsed duration
- Color by model: opus-4-6 #58a6ff, opus-4-8 #7ee787, fable-5 #d2a8ff, sonnet-4-6 #ffa657, haiku-4-5 #f0883e
- Failed turns: #f85149
- Selected turn: white stroke
- Gaps between bars = waiting time (data, not decoration)

**Row 2 — Context sparkline:**
- 16px area chart showing contextPercent over time
- Fill color = model color at 15% opacity
- Line color = model color at 60% opacity

**Spawn connectors:** 0.5px gray (#30363d) vertical lines from parent turn to child lane's first turn. Subtle — spatial alignment on time axis is the primary signal.

**Lane labels (240px, same width as Agent Card):** `agent-name` + `model  ctxWindowK` directly integrated. Selected lane: `▶` prefix + 2px blue left bar + subtle blue background.

## Context Threshold Reference Lines

On the Agent Card minimap:
- **40%** — green dashed line, labeled "40%" — smart zone ceiling
- **83.5%** — red dashed line, labeled "83.5%" — autocompact threshold, shows ⚠ warning if peak exceeds

## Agent Card Charts (unified X axis)

Three charts stacked vertically in the Agent Card, all sharing turn-index X axis:

1. **Context minimap** (48px height) — area chart with threshold lines
2. **Cache hit sparkline** (14px height) — bar chart, green (#3fb950), yellow (#d29922) when < 50%
3. **Cost sparkline** (14px height) — bar chart, orange (#ffa657)

Click any chart → select nearest turn → blue cursor line appears on all three → Timeline Steps scrolls to that turn.

## Timeline Vertical Scrolling

When agents exceed the visible height (common with Workflow spawning 10+ subagents), the timeline area scrolls vertically. Lane labels scroll with the timeline (they are part of the SVG). The minimap always shows all lanes regardless of scroll position.

## Workflow Collapse/Expand

Dynamic Workflow (`Workflow` tool) subagent turns can be collapsed into a single summary lane:

```
Collapsed:
  main   ▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕
  ▸ wf: issue-priority-planning  2 phases · 8 agents · 147 turns  ████████████

Expanded (click ▸):
  main   ▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕▕
  ▾ wf: issue-priority-planning
    issue-48  ▕▕▕▕▕▕▕▕▕▕
    issue-64  ▕▕▕▕▕▕▕▕
    issue-82  ▕▕▕▕▕▕▕▕▕▕▕▕
    feature   ▕▕▕▕▕▕▕▕▕▕▕
    synth     ▕▕▕▕▕▕▕
```

### Data source for Workflow grouping

The Workflow `tool_use` input contains a `script` field with:
- `export const meta = { name, description, phases[] }` — workflow identity
- `agent()` calls with `label` and `phase` parameters — subagent structure
- `parallel()` / `pipeline()` calls — execution topology

The Workflow `tool_result` returns: Task ID, Summary, Run ID, Transcript dir. **No per-agent completion status** — that information only exists in Claude Code's internal harness (task-notifications), not in the API traffic ccxray captures.

### Collapse heuristic
1. Parse `meta.name` and `meta.phases[]` from the Workflow tool_use input script
2. Group all subagent turns that fall within the Workflow's time window (from Workflow tool_use to the next orchestrator turn after all subagents complete)
3. Show collapsed by default when subagent count > 4
4. Click ▸/▾ to toggle

## Subagent Lane Inference (heuristic, no backend change)

Turns assigned to lanes using:
1. Spawn registry: turns with `agentSpawns[]` populate spawn slots
2. After a spawn, turns with `contextPercent < orchCtxLevel * 0.5 AND < 25%` are subagent candidates
3. Match by time proximity (within 120s of spawn)
4. Main lane gets everything else
5. Lane model = dominant model across turns
6. Future: server-side `entry.spawnedBy` / `entry.parentEntryId` would make this deterministic

## Compromises

| What | Compromise | Upgrade path |
|------|-----------|-------------|
| Spawn matching | Time-window heuristic, can mispair | Server stamps explicit `spawnedBy` field |
| Task lifecycle (#6) | Not addressed in v1 | Gantt-style Task track as separate view |
| Multi-layer spawn (#4) | Inference only handles 1 layer reliably | Explicit parent chain from server |
| Fork subagents | Share parent's cache fingerprint, hard to distinguish | Need session ID from subagent headers |
| Summary-only entries | `toolCalls` is `{name: count}`, no Agent descriptions | Load full `req.messages` for spawn labels |
| Context % accuracy | `input_tokens + cache_read + cache_create` may exceed window for 1M models | Validate against actual model context limits |
| Cost estimates | Rough pricing ($3/M in, $0.30/M cache, $15/M out) | Use ccxray's `server/pricing.js` for accurate rates |

## Test Data

10 sessions in `prototype-fixture.json`:

| Session | Turns | Models | Pattern |
|---------|------:|--------|---------|
| two-wave-eval | 15 | opus-4-6 | Two waves of 3×3 spawn |
| fork-build | 14 | opus-4-6/4-8 | Long prep then 3× fork |
| code-review-4x | 5 | opus-4-6/4-8 | Immediate 4-way fan-out |
| serial-codex | 7 | opus+sonnet | Serial codex-rescue |
| sequential-fork | 9 | opus-4-6/4-8 | Spawn → work → spawn again |
| **fable-337** | **346** | **fable+opus+sonnet+opus-4-8** | 80min, 4 models, 2 waves (6+3) |
| **fable-161** | **471** | **fable+opus+sonnet+haiku** | 56min, 4 models, largest |
| **workflow-147** | **147** | opus-4-6 | Workflow audit, dense parallel |
| **workflow-149** | **149** | opus-4-8+haiku | Mixed model workflow |
| **workflow-129** | **129** | opus+opus+haiku | 3-model workflow |

## File Map

- Prototype: `prototype/tufte/index.html` + `tufte.js`
- Fixture: `prototype-fixture.json`
- Production target: `public/miller-columns.js` (replace Turns column), `public/workflow-timeline.js` (new), `public/messages.js` (reuse detail rendering)
- Server: no changes needed for v1 (all data already captured)
