# Design Teaching Loop Plan

Parity response to Claude Design, grounded in a live product audit (2026-09-23
session: home surface, project editor, design-system document, devtools).
Claude Design's core moat is not the model — it is three loops around a
structured design-system document:

1. **Compliance-as-you-generate** — "Check design system" runs mid-run, inside
   the agent turn.
2. **Feedback persistence** — per-token Feedback / Edit / Add-usage-notes
   writes human judgment back into the contract.
3. **Anchor-stable shared artifacts** — token-minted per-project previews with
   an injected observer that re-anchors comments as the DOM shifts.

OpenDesign already owns every ingredient as files or repo-side logic
(`DESIGN.md`, `tokens.css`, `craft/`, `scripts/guard.ts` token checks, srcdoc
injection points, desktop inspect machinery). This plan wires them into the
product runtime. It does not duplicate the
[`design-system-2-backfill-plan.md`](./design-system-2-backfill-plan.md); it
extends the 2.0 package shape that plan defines.

A fifth phase absorbs Claude Design HTML exports into consumable context —
extending the existing ZIP importer (`claude-design-import.ts`) from raw
extraction into normalization, classification, structured context
extraction, and design-system derivation.

A sixth phase adds connected targets with draft-then-promote: OD projects
draft in the sandbox and land in a real local or GitHub project through a
gated promotion path that is the only write door to the target.

## Non-goals

- No Connect-RPC layer; HTTP + SSE contracts stay.
- No visual-regression infra; e2e already owns it.
- No component-library runtime; the document-contract bet is the
  differentiator.
- No model-dependent features; every capability must work across the 25
  supported CLIs.

## Task dependency graph

```
A1 token semantics ──┬──> B1 check_design_system ──> D2 section feedback
A2 DESIGN.md schema ─┘        │
C3 manifest cache ────┬──────>└──> D1 document canvas
A1 + A2 + C3 ─────────┘
B2 render probe (independent)
B3 stream roll-ups (independent)
C1 anchor comments (independent)
C2 preview tokens (independent)
D3 composer chips (independent)
D4 defaults + list affordances (independent)
E1/E2 absorb pipeline (independent) ──> E3 context extraction ──> E4 ds source (needs A1)
F1 connected target (independent) ──┬──> F2 target context (needs E3)
                                   ├──> F3 base snapshot + drift
                                   └──> F4 change kinds + staged view
F3 + F4 ──> F5 promotion ──┬──> F6 gate (write-guard, approval, lock)
                           ├──> F8 feedback loop (needs B3)
                           └──> F9 promote-time ds check (needs B1)
F7 security (needs F1; secret scan hooks F5)
```

---

## Phase A — Teaching-contract schema (foundation)

### A1. Token usage notes, derivations, and relations

Extend the Design System 2.0 package shape with token semantics. A token entry
in `design-tokens.json` (and mirrored in `manifest.json` where the 2.0
importer emits it) gains optional fields:

```jsonc
{
  "name": "--color-primary-hover",
  "value": "oklch(0.51 0.19 27.5 / .88)",
  "usage": "Primary button hover only; never for text or links.",
  "derivation": "mix 85% --color-primary, 15% transparent",
  "relations": { "inherits": "--color-primary" }
}
```

**Actions**

1. Add `DesignTokenSemantics` types to `packages/contracts/src/design-systems/`
   (pure TS; no Node/DOM APIs). Export through the existing contracts entry.
2. Extend the 2.0 importer in `apps/daemon/src/design-systems/` to accept and
   emit the fields; unknown fields are preserved, not stripped.
3. Extend `scripts/check-tokens-fixture-sync.ts` and the token-contract report
   generator to validate semantic fields: derivation strings must reference
   tokens that exist; relations must resolve within the same package.
4. Surface `usage` in the existing ManualEditPanel reference-values strip
   (`apps/web/src/components/ManualEditPanel.tsx` already renders
   `matchReason · sourceFile:line` — add usage text to the chip title).

**Acceptance**: contract typecheck; a daemon test importing a fixture package
with semantic fields round-trips them; guard rejects a package whose
derivation references a missing token; ManualEditPanel test asserts the usage
string appears in the chip title attribute.

**Depends on**: Design System 2.0 backfill setup PR (shape exists); schema
fields are optional so bundled 1.0-era systems keep validating.

### A2. DESIGN.md section schema (optional outline)

Claude Design's document has a de-facto taxonomy: voice/content fundamentals,
visual foundations, **anti-patterns**, **provenance** (sources, exported
components, caveats + substitutions). Define an optional heading outline so
agents and UIs can address sections structurally. Freeform `DESIGN.md` remains
valid — parsing extracts what matches and ignores the rest.

**Actions**

1. Add `DesignSystemDocumentSection` types to
   `packages/contracts/src/design-systems/` with the canonical section ids:
   `identity`, `voice`, `visual-foundations`, `anti-patterns`, `provenance`,
   `caveats`. Sections carry `id`, `title`, `body` (markdown), and line spans.
2. Implement the parser in the daemon design-systems service (heading-walk;
   no new dependency — the repo already parses markdown frontmatter for
   skills).
3. Add a bundled-package audit to `scripts/guard.ts`: report (not fail) how
   many bundled systems carry `anti-patterns` and `provenance` sections, to
   seed later content backfill.
4. Include parsed sections in the design-system listing/detail API responses.

**Acceptance**: contracts typecheck; daemon parser test extracts sections from
a fixture `DESIGN.md` with mixed conforming/non-conforming headings; API
response test asserts section payloads; guard audit runs without failing
existing packages.

**Depends on**: nothing. Highest-leverage single task; A1 and A2 unlock
everything downstream.

---

## Phase B — In-run agent loop

### B1. `check_design_system` agent tool

Expose the existing repo-side checks as a daemon service callable mid-run by
any CLI. This is the wiring change that turns `scripts/guard.ts` logic from a
repo CI gate into a generation-time verifier — Claude Design's "Check design
system" step.

**Actions**

1. Extract the runtime-relevant checks (A1/A2/B-slot token presence, unknown
   token detection, fixture sync, token-contract report re-validation) from
   `scripts/guard.ts` and `scripts/check-tokens-fixture-sync.ts` into a pure
   module under `packages/plugin-runtime` or a new pure owner — guard.ts then
   imports it, so there is exactly one implementation. Choose the owner by
   import graph at implementation time; do not duplicate logic.
2. Daemon service in `apps/daemon/src/design-systems/` runs the checks against
   a project's active package **plus the project's generated files** (scan
   rendered HTML/CSS for unknown token usage).
3. Three-step closure in one PR: contract types
   (`packages/contracts/src/api/design-system-check.ts`), route
   (`POST /api/design-systems/:id/check` and
   `POST /api/projects/:id/check-design-system`), CLI
   (`od design-system check <project> --json` via `SUBCOMMAND_MAP`), MCP tool
   registration (`check_design_system`) through the existing `od mcp` surface.
4. Author a functional skill `skills/check-design-system/SKILL.md` that
   instructs agents to invoke the check after writing design output — for
   non-MCP runtimes.

**Acceptance**: e2e Vitest at the daemon HTTP boundary — a project with a
deliberate token violation reports it via the route; `od design-system check
--json` exits nonzero on violation; MCP tool listing includes the tool; guard
still passes repo-side (single shared implementation).

**Depends on**: A1 (semantic validation), A2 (section checks). The token
presence/unknown-token subset can land first.

### B2. `render_probe` agent tool

OD's differentiator: a real local browser the agent can drive. Surface the
desktop-inspect machinery (`tools-dev inspect desktop eval/screenshot`) as an
MCP tool so agents verify rendered output mid-run.

**Actions**

1. Daemon-side probe service: load a project file through the existing
   preview serve path, execute an expression or capture a screenshot headless
   (reuse the e2e Playwright harness driver — it already exists in
   `e2e/lib/tools-dev/`; the daemon needs its own thin driver, not an import
   of e2e internals — boundary rule).
2. MCP tool `renderProbe` with inputs `{ file, expression?, screenshot? }`;
   returns eval result or PNG path under the project's artifacts.
3. Skill `skills/render-probe/SKILL.md` teaching the check-after-generate
   loop ("verify routes render, probe one interaction before finishing").
4. CLI: `od probe <project> --file <f> --eval <expr> --json`.

**Acceptance**: daemon test probing a fixture project returns the evaluated
expression; MCP listing includes the tool; e2e smoke: fake agent run invokes
the probe (extend an existing mock-CLI replay).

**Depends on**: nothing. Independent of Phase A.

### B3. SSE stream roll-ups and todo events

Claude Design's run readability: aggregated tool chips ("Writing ×4,
Searching") and in-stream "Updated todos". OD normalizes events per-runtime;
add two cross-runtime layers.

**Actions**

1. Contract: `packages/contracts/src/sse/chat.ts` — add `tool_activity`
   (periodic roll-up: tool kind → count since last emission) and `plan_update`
   (todo list snapshot) event types to the SSE union.
2. Daemon: roll up normalized tool events per turn in the run stream
   composers (`apps/daemon/src/runtimes/`); parse plan/todo output from
   CLIs that emit it structurally, else omit.
3. Web: ChatPane renders roll-up chips and a collapsible todo list; absent
   events degrade silently.

**Acceptance**: contracts typecheck; daemon unit test feeding a synthetic
event stream emits roll-ups; web component test renders the chip and todo
list; no event → no UI (asserted).

**Depends on**: nothing.

---

## Phase C — Preview infrastructure

### C1. Anchor-stable comments

Comment pins drift when the DOM shifts. Claude Design's mechanism (verified in
devtools): serve previews with an injected observer that emits
`anchorMoved {rect}` events the host uses to re-anchor pins.

**Actions**

1. Extend `packages/contracts/src/runtime/html-injection-points.ts` with a
   comment-anchor bridge: mutation observer + `getBoundingClientRect` on
   comment-anchored elements, posting `anchorMoved` messages to the host.
2. Host handler in the web file workspace re-positions pin overlays; validate
   sending frame (existing pattern in the preview message handlers).
3. Red spec first: the existing comment-drift e2e/web tests become the
   failing case — reproduce drift, then fix with the bridge.

**Acceptance**: the comment-drift test passes with a DOM mutation between pin
and assertion; pins track an element that moves (web component test with
jsdom-driven rect changes); no regression in srcdoc render-mode switching.

**Depends on**: nothing.

### C2. Per-project preview tokens

Previews currently serve same-origin under `/frames/*` / `/artifacts/*`. Add
short-lived serve tokens so one project's preview URL cannot be fetched
cross-project without a minted grant.

**Actions**

1. Contract: preview-token types in `packages/contracts/src/api/`.
2. Daemon: `POST /api/projects/:id/preview-token` mints a short-lived
   (minutes) token bound to project id + serve path prefix; serve routes
   validate it for any cross-origin fetch (same-origin app fetches keep
   working via existing auth).
3. Web: mint before constructing cross-origin preview URLs; token refresh on
   expiry.
4. CLI: not user-facing; no `od` subcommand needed (internal route only —
   note in PR body per the surface checklist).

**Acceptance**: daemon route test — token from project A rejected for project
B's path; expired token rejected; web preview still renders (existing preview
e2e green).

**Depends on**: nothing.

### C3. Resolved design-system manifest cache

Resolve `DESIGN.md` + `tokens.css` + `manifest.json` + `design-tokens.json`
once per project selection, server-side, and cache the resolved document
(invalidated by package file mtimes) — the `omelette:ds-manifest:v1` pattern.
Feeds D1 without re-reading packages per render.

**Actions**

1. Daemon service: resolve-and-cache with mtime invalidation; cache lives in
   memory (re-resolve is cheap; no new daemon data on disk).
2. Route: `GET /api/projects/:id/design-system/resolved`.
3. Contract types for the resolved document (sections from A2, tokens with
   semantics from A1).

**Acceptance**: daemon test — mutate a package file, cache re-resolves;
resolved payload contains sections + semantic tokens; route test green.

**Depends on**: A1, A2.

---

## Phase D — Surfaces

### D1. Design-system document canvas

The headline parity feature: render the active package as a canvas document
with section outline, live token swatches, and per-section actions.

**Actions**

1. Web: new canvas tab in the file workspace consuming C3's resolved
   document; section outline rail; token groups with swatches rendered from
   token values (small iframes or inline styles); sections rendered from A2
   markdown.
2. Per-section actions: **Feedback** (opens a small composer whose text is
   injected into the next chat prompt as critique context — reuse the
   existing critique/prompt-composition service), **Edit** (opens the section
   source in the file editor — the package root is already user-writable via
   the shadowing mechanism), **Add usage notes** (D2).
3. CLI: `od design-system show <project> --json` returning the resolved
   document (machine surface for external agents).

**Acceptance**: web component tests for outline/swatch/section rendering;
e2e: open canvas from project view, all sections render for a 2.0 fixture
package; CLI returns the same document shape.

**Depends on**: A1, A2, C3.

### D2. Per-section feedback → usage-notes persistence

Close the teaching loop: canvas feedback and usage notes persist back into
the package (A1 fields / A2 section bodies), surviving across projects and
agents.

**Actions**

1. Route: `POST /api/design-systems/:id/tokens/:name/usage` and
   `POST /api/design-systems/:id/sections/:sectionId/notes` writing to the
   user-writable package root (bundled packages are shadowed on first write —
   existing mechanism).
2. Web: wire D1's Add-usage-notes and Feedback composers.
3. CLI: `od design-system note <id> --token <name> --usage <text>` and the
   section variant.

**Acceptance**: writing a note to a bundled package creates the shadow copy
with the note and leaves the bundled original untouched (daemon test); canvas
shows persisted notes after reload (e2e); CLI round-trips.

**Depends on**: A1, D1.

### D3. Composer context chips + template starters + start-from-code

**Actions**

1. Entry composer chips for active design system, agent, and skill/template —
   all three visible before first submit (data already served by
   `/api/design-systems`, `/api/agents`, `/api/skills`).
2. Template chips: top design-templates as one-click starters that prefill
   prompt + primary template.
3. "Start from code" toggle on the composer mapping to the existing folder
   import + repo-refresh flow.

**Acceptance**: web component tests for chip state and starter prefill;
e2e: create a project via a template chip; start-from-code opens the import
flow with the toggle reflected.

**Depends on**: nothing.

### D4. Workspace-default design system + list affordances

**Actions**

1. App-config extension: `defaultDesignSystemId` at workspace level; new
   projects inherit; per-project selection remains an override.
2. Starred filter and thumbnail view for projects and templates (project
   thumbnails can reuse the deck-sniff/preview capture the product already
   performs; degrade to icon when unavailable).

**Acceptance**: config round-trip test; new project inherits default
(daemon test); starred filter and thumbnail toggle component tests.

**Depends on**: nothing.

---

## Phase E — Claude Design HTML absorption

Claude Design exports are single-file HTML artifacts. The existing importer
(`/api/import/claude-design`, `apps/daemon/src/design/claude-design-import.ts`)
unpacks a ZIP and normalizes one canvas quirk — it does not make the HTML
*consumable*. This phase turns absorbed files into renderable, editable,
agent-visible context. Grounding evidence from the live devtools audit:
Claude Design files embed Tailwind Play CDN + in-browser Babel scripts, a
`__OM_EVT__` console bridge, relative `assets/` references, and the
`*.dc.html` design-canvas naming convention.

### E1. Absorb pipeline: raw HTML file ingest

Extend ingest beyond ZIP to single/multiple raw HTML files, with
Claude-Design-specific normalization applied on write.

**Actions**

1. Route: accept loose `.html` files through the existing import surface —
   `POST /api/import/claude-design` gains a JSON/multipart mode accepting
   files directly (ZIP stays the primary path); sanitization and limits reuse
   `claude-design-import.ts` constants (MAX_FILES/MAX_TOTAL_BYTES/
   MAX_FILE_BYTES).
2. Normalization on write, extending `normalizeImportedClaudeDesignFile`:
   - strip `__OM_EVT__` console bridge and `_omeo`/`srcmap` query params
     (host-integration remnants that OD's preview doesn't need);
   - rewrite CDN reliance (Tailwind Play CDN, Babel standalone, React UMD)
     to OD's vendored local runtime paths — the same vendoring decision the
     web app already made for its own sandbox (`apps/web/src/runtime/react-component.ts`
     patterns), so artifacts render offline;
   - absolutize relative `assets/` references against the project root.
3. CLI: `od import claude-design <file...> --project <id>` (and the existing
   ZIP form) with `--json`.
4. Tests: daemon test ingesting a fixture Claude Design HTML (with the
   markers above) asserts normalized output — no `__OM_EVT__`, local runtime
   paths, rewritten asset refs.

**Acceptance**: route + CLI tests green; fixture HTML normalizes correctly;
`pnpm guard` clean (no new `.js` files).

**Depends on**: nothing.

### E2. File-type detection and canvas detection

Absorbed files should land in the right project workspace surface with the
right preview mode.

**Actions**

1. Detection helper (pure, in daemon design domain): classify an absorbed
   file as design-canvas (`*.dc.html` or containing `design-canvas.jsx`
   markers), deck, prototype, or generic HTML — reusing the deck-sniff logic
   the product already performs (the `omelette.deckSniff` analog in OD's
   existing file typing).
2. Classification drives: entry-file choice in the importer (prefer the
   richest artifact, not just `index.html`), preview render-mode decision
   (`file-viewer-render-mode.ts` already owns srcdoc-vs-URL), and the
   file-workspace icon/grouping.
3. Contract type: `AbsorbedFileKind` in `packages/contracts/src/api/`.

**Acceptance**: classification unit tests across fixture kinds; importer
prefers a detected canvas over `index.html`; render-mode decision consumes
the kind without a separate probe.

**Depends on**: E1.

### E3. Context extraction: HTML → agent-consumable context

The core "convert to usable context" capability: turn absorbed HTML into
structured context any OD agent can consume — not just a previewable file
but a design brief the agent reads when iterating on that project.

**Actions**

1. Pure extractor in daemon design domain: from an absorbed HTML file
   produce a structured context document containing: page structure outline
   (headings/sections/nav/main/footer landmarks), color usage (resolved CSS
   custom properties + computed frequency), typography stack, spacing/radius
   patterns, component inventory (buttons/inputs/cards/tables detected via
   class heuristics), and asset inventory (images/fonts referenced).
2. Persist as `context/design-context.json` (contracts-typed) alongside the
   artifact in the project workspace; regenerate on file change via the
   existing file watcher.
3. Prompt composition: when a run starts in a project with absorbed files,
   the prompt composer includes a compact design-context digest (structure +
   palette + type + components) in the system context — same injection point
   the design-system `DESIGN.md` already uses.
4. MCP tool `getDesignContext` returning the same document for mid-run
   queries; CLI `od context design <project> --file <f> --json`.
5. Skill `skills/absorb-claude-design/SKILL.md`: teaches the
   import → normalize → extract → iterate loop, including "ask for the
   design-context digest before restyling an absorbed artifact".

**Acceptance**: extractor unit tests on fixtures (one canvas, one deck, one
prototype); prompt composer test asserts the digest appears when an absorbed
file exists and is absent otherwise; MCP listing includes the tool; skill
passes the skills guard.

**Depends on**: E1, E2.

### E4. Claude Design HTML as a design-system source

New source adapter for the 2.0 importer: extract CSS custom properties and
token-like declarations from imported Claude Design HTML into a
design-system package — closing the loop from absorbed artifact to teaching
contract (Phase A schema).

**Actions**

1. Source adapter beside the existing local/GitHub/shadcn extractors in the
   2.0 importer: parse `<style>` blocks and inline `style="--…"` attributes
   from imported HTML; map to the 2.0 token schema (56-token vocabulary);
   unknown values fall to the same weak-evidence grading the importer already
   applies.
2. Import entry: `POST /api/design-systems/import-source` with
   `{ kind: 'claude-design-html', projectId, fileGlob }` — derives from files
   already in the project (post-E1), no re-upload.
3. CLI: `od design-system import-from claude-design --project <id> --json`.
4. Provenance: generated package records `claude-design-import` as its source
   kind in `source/evidence.md`, matching the 2.0 provenance rules.

**Acceptance**: daemon test importing a fixture Claude Design HTML file with
inline CSS custom properties produces a package whose token report grades and
schema coverage match the 2.0 contract; provenance names the source; guard
passes on the generated package.

**Depends on**: E1 (files present in project), A1 (semantic fields emitted).

---

## Phase F — Connected targets with draft-then-promote

Today OD writes either into its managed daemon workspace or — folder-import
mode — directly into a user's real project (`import-export-routes.ts:190`,
"every write goes to `metadata.baseDir`", the Cursor/Claude Code model). This
phase adds the missing third mode: draft inside the OD sandbox, promote into
the real project through a gate. Targets are a local path or
`github:owner/repo`. GitHub today is only an install source
(`github-install-source.ts`), never a project connection.

Design stance: promotion is the **only** write path to a connected target.
The agent never writes the target directly; the gate is real because it is
the only door (F6). Folder-import mode remains for users who opt into
direct-write.

### F1. Connected-target model

External target binding as a deployment destination, not the workspace.

**Actions**

1. Contracts: `ConnectedTarget` types (`packages/contracts/src/api/targets.ts`)
   — `{ kind: 'local-folder' | 'github-repo', localPath?, owner/repo?, defaultBranch }`,
   plus target binding/response DTOs.
2. Daemon: target registry service under `apps/daemon/src/targets/`; stored in
   project metadata (SQLite), not files.
3. Routes: `POST /api/projects/:id/target`, `GET .../target`, `DELETE
   .../target` in a new `routes/targets.ts` registrar (narrow deps, semantic
   section in `server.ts`).
4. Local binding reuses the desktop-auth trust gate from folder import
   (same `x-od-desktop-import-token` flow); GitHub binding stores owner/repo
   only — no token yet (F7).
5. CLI: `od target connect <path|github:owner/repo> --project <id>`,
   `od target status --project <id>`, `od target disconnect --project <id>`,
   all `--json`.

**Acceptance**: route tests for bind/list/unbind round-trip; local bind
rejected without the desktop token; CLI round-trips; `pnpm guard` green.

**Depends on**: nothing.

### F2. Target context acquisition

The agent cannot draft blind. Before the first run against a connected
target, extract the same digest E3 produces — structure outline, tokens,
component inventory — plus stack detection (framework, dependency versions)
from the target, and inject it into prompt composition for that project.

**Actions**

1. Reuse the E3 extractor pointed at the target path (local) or a shallow
   fetch (GitHub tarball via the existing `github-install-source.ts` fetch
   plumbing).
2. Persist `context/target-context.json` per project; regenerate on
   target re-bind and on demand.
3. Prompt composer: inject target digest beside the design-system
   `DESIGN.md` injection (`prompts/system.ts` same section).
4. MCP tool `getTargetContext`; CLI `od target context --project <id> --json`.

**Acceptance**: extractor test against a fixture repo layout; prompt
composer test asserts digest presence with a target bound and absence
without; MCP listing includes the tool.

**Depends on**: F1, E3.

### F3. Base snapshot + drift detection

The target moves while you draft. Record the target's state at connect time
(git commit SHA for repo targets; content-hash manifest for plain folders),
re-read at promote time, and surface drift as a conflict report.

**Actions**

1. Snapshot service in `apps/daemon/src/targets/`: git targets record
   `HEAD` SHA + remote URL; folder targets record a deterministic
   content-hash manifest (path → hash, ignoring `.git`, `node_modules`,
   build outputs).
2. `GET /api/projects/:id/target/drift` — re-reads current state, diffs
   against snapshot, returns per-file added/changed/removed vs base.
3. Promote flow (F5) calls drift first; conflict → block with report
   unless the user explicitly chooses overwrite-or-rebase per file.
4. CLI: `od target drift --project <id> --json`.

**Acceptance**: unit tests — folder drift detection on mutated fixture;
SHA capture on a git fixture; drift endpoint test; promote blocked on
conflict in the F5 tests.

**Depends on**: F1.

### F4. Change kinds + staged-changes view

Distinguish target-framework code files from OD design artifacts, and give
the user a review surface before anything lands.

**Actions**

1. Contracts: `ChangeKind = 'verbatim' | 'design-adapt'` per staged file;
   classification heuristics: files under a declared target framework
   (detected in F2) are verbatim; OD sandbox artifacts (`.dc.html`,
   generated HTML/React) are design-adapt.
2. Staged-changes model: pending files are the OD project's generated files
   diffed against the target base snapshot (F3) — no separate staging tree.
3. Web: "Changes vs target" tab in the file workspace: per-file kind,
   diff view (reuse ManualEditPanel diff machinery), included-by-default
   checkbox, scratch/generated excluded.
4. CLI: `od target changes --project <id> --json`.

**Acceptance**: classification unit tests; web component test for the
staged-changes tab (kind badge, include toggle, diff render); CLI
round-trip; drift-conflict interplay tested at F5.

**Depends on**: F1, F3.

### F5. Promotion engine

Apply staged changes to the target — git-first, never raw-overwrite a repo.

**Actions**

1. Promotion service: for git targets (local checkout or GitHub), create
   branch `od/<project-slug>/<change-slug>`, apply staged files as one
   commit, push; GitHub targets open a PR via `gh` CLI (reuse the existing
   `gh` plumbing the repo already ships); PR body links back to the OD
   project URL and the generating run id.
2. Non-git folders: apply with a pre-apply backup snapshot under
   `RUNTIME_DATA_DIR`, recorded in promotion history.
3. `POST /api/projects/:id/target/promote` with body `{ fileIds, mode:
   'pr' | 'branch' | 'copy' }`; `--dry-run` returns the exact file list +
   drift report without touching anything.
4. Promotion history record (project id, run id, target, files, commit/PR
   URL, timestamp, mode) persisted in SQLite; exposed via
   `GET /api/projects/:id/target/promotions`.
5. CLI: `od target promote --project <id> [--files <ids>] [--dry-run]
   [--mode pr|branch|copy] --json`.
6. Commit messages follow the repo convention (no Co-authored-by trailers).

**Acceptance**: promote service tests on local git fixture (branch created,
commit present, working tree clean); dry-run touches nothing; PR-mode test
against a mock `gh` (mocks/ replay pattern); promotion history round-trip;
conflict (F3) blocks without explicit override.

**Depends on**: F3, F4.

### F6. The gate: single write path + approval + lock

The gate is real only if promotion is the only door.

**Actions**

1. Runtime write-guard: when a project has a connected target, the agent's
   write surface excludes the target path — enforce in the daemon's file
   write path used by agent runs (same boundary `validateProjectPath`
   guards), rejecting writes that resolve into a bound target.
2. Approval: promote requests require explicit confirmation — web UI
   confirm dialog + CLI `--yes` (non-interactive use must pass `--yes`).
3. Promote lock: one promotion in flight per project target; second
   attempt rejected with 409 while the first runs.
4. Audit: every promote/dry-run/override records an audit event
   (actor, mode, files, drift decision) alongside promotion history.

**Acceptance**: write-guard unit test — agent write into bound target path
rejected; lock test — concurrent second promote 409s; approval-missing
promote rejected; audit records present.

**Depends on**: F5.

### F7. Security: credentials, secret scan, trust

**Actions**

1. GitHub tokens in the daemon's existing credentials store under
   `RUNTIME_DATA_DIR`, fine-grained scope `contents:write` per target;
   never in project files or config.
2. Secret scan of staged files before promote: same detector family the
   repo already uses for credential hygiene (grep the existing
   secret/credential scan utilities; reuse, do not duplicate) — match →
   block promote, report file + line, require explicit override with
   audit.
3. Local target binding reuses the desktop trust gate (F1 action 4);
   `gh` invoked with `--repo` only, never token-on-argv.

**Acceptance**: token stored/retrieved via credentials store only
(fspath test asserts no token material in project dir); secret-scan unit
test blocks a fixture file containing a fake key; override path audits.

**Depends on**: F1 (scan hooks into F5 promote flow).

### F8. Post-promote feedback loop

One-shot promotion is an export button; the loop is the feature.

**Actions**

1. PR/CI status polling via `gh pr view --json` (poll, no webhooks) on a
   schedule while a promotion's PR is open; status events surface in the
   project run stream as normalized SSE events (B3's event union).
2. File state in the workspace: `pending` vs `shipped` (from promotion
   history); the staged-changes view (F4) shows shipped files as done.
3. Failed checks → the agent iterates in the draft and re-promotes;
   re-promote skips files unchanged since the last promotion of the same
   target.

**Acceptance**: poller unit test on mock `gh` replay; SSE status event
emitted (extends B3 test); shipped-state reflected in staged view;
re-promote skips already-shipped unchanged files.

**Depends on**: F5, B3.

### F9. Promote-time design-system check

When the target repo has its own tokens/design system, run the B1 check
against the target's tokens at promote.

**Actions**

1. Promote hook: if `context/target-context.json` (F2) detects design
   tokens in the target, run the B1 `check_design_system` core against
   the staged design-adapt files before landing; violations surface in
   the promote review, block by default with override.
2. CLI surfaces the same report in `od target promote --dry-run`.

**Acceptance**: promote blocked on a token-violation fixture, passes on a
clean one; report present in dry-run output.

**Depends on**: F5, B1.

---

## Task checklist

- [x] A1 Token usage/derivation/relations *(done — local)*
- [x] A2 DESIGN.md section schema *(done — local)*
- [ ] B1 check_design_system tool
- [ ] B2 render_probe tool
- [x] B3 SSE roll-ups + todo events *(merged, wired into emitAgentEvent)*
- [x] C1 Anchor-stable comments *(merged)*
- [x] C2 Per-project preview tokens *(merged, wired before static serve)*
- [ ] C3 Resolved design-system manifest cache
- [ ] D1 Design-system document canvas
- [ ] D2 Feedback→usage-notes persistence
- [ ] D3 Composer chips + template starters + start-from-code *(helpers only, UI not wired)*
- [ ] D4 Workspace-default design system + starred filter + thumbnails *(default id stored; list UI not wired)*
- [x] E1 Absorb pipeline (raw HTML ingest + normalization) *(merged)*
- [x] E2 File-kind detection *(merged)*
- [ ] E3 Context extraction (design-context.json + MCP tool + skill)
- [ ] E4 Claude Design HTML → design-system source adapter
- [x] F1 Connected-target model *(merged, `od target` wired)*
- [ ] F2 Target context acquisition
- [ ] F3 Base snapshot + drift detection
- [ ] F4 Change kinds + staged-changes view
- [ ] F5 Promotion engine
- [ ] F6 The gate (write-guard, approval, lock)
- [ ] F7 Security (credentials, secret scan)
- [ ] F8 Post-promote feedback loop
- [ ] F9 Promote-time design-system check

## Sequencing

| Order | Tasks | Rationale |
| --- | --- | --- |
| 1 | A2, A1 | Schema unlocks B1, C3, D1, D2, E4. A2 has no dependency; start immediately. |
| 2 | B3, C1, C2, D3, D4, E1, F1 | All independent; can proceed in parallel with Phase A completion. |
| 3 | B1, B2, E2 | Agent loop; B1's token subset can start during Phase A. |
| 4 | C3, E3 | Consume A1+A2 / E1+E2 respectively. |
| 5 | D1, D2, E4 | Surfaces consuming everything. |
| 6 | F3, F4 | Consume F1; independent of phases B–E except F2 needs E3. |
| 7 | F5, F7 | Promotion engine + security hardening. |
| 8 | F6, F8, F9 | Gate, feedback loop, promote-time ds check. |

Content note: A2's guard audit will show near-zero bundled systems carrying
`anti-patterns`/`provenance` sections. Backfilling those sections across the
catalog is a follow-on content batch in the style of the 2.0 backfill plan
(setup PR + batched generated PRs) — deliberately not in scope here.

## Repo constraints binding every task

- Three-step closure per capability: contract type → daemon route → web
  surface + `od` subcommand, same PR. B2's render probe and C2's internal
  token route note their CLI/applicability status in the PR body.
- `packages/contracts` stays pure TS — no Node/DOM/browser APIs.
- Daemon data through `RUNTIME_DATA_DIR` only (C3 is in-memory; D2 writes to
  the user-writable package root).
- Tests in `tests/` siblings; cheapest layer first; red spec first for C1.
- No new `.js`/`.mjs` files; guard must stay green.
