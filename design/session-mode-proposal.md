# Proposal: collaborative session mode on workspaces

Status: **strawman for discussion** (2026-07-21). Synthesized from three parallel
investigations: the Artifacts substrate contract, industry precedents (Zed, Figma, Google
Docs, github.dev, Replit, GitBook, Hocuspocus/Y-Sweet), and a mounts × sessions design pass
against workspace-core/streams source. Companion file: `collaborative-workspaces.md`
(requirements, facts, log).

## Rev 2 (2026-07-21): the session unit is the WORKSPACE, not the file

Jonas's pushback on Rev 1's one-DO-per-(workspace, filePath):

> "I just don't want to cruft up the world with a million different durable objects that
> have their own storage and so on. … for this use case of monkeying about with a bunch of
> tasks or markdown files, it feels to me like having one doc for basically the files that
> we have touched in this checkout is really what they represent, right? Everything else is
> a fall through read."

Accepted — it is more aligned with invariant 1 than Rev 1 was. Revised model:

- **One live Y.Doc per workspace, hosted by the workspace DO itself.** No
  `WORKSPACE_SESSION` DO namespace, no session registry, no per-file lifecycle. The doc is
  **the overlay's live mirror**: entries exist for exactly the *touched set* (dirty files +
  files open for editing). Clean files never have a Yjs representation — they are
  fall-through reads. Doc size scales with the dirty set, not the repo, so the
  massive-repo story is unaffected (boards/trees over clean files are server-derived
  state, never doc content).
- **The live layer is (near-)stateless.** The doc is derivable from the overlay at any
  quiescent point. Persist no doc state: flush debounced ~2s into the overlay; a DO crash
  loses at most the unsettled tail (~2s of typing); rejoin re-seeds from the overlay.
  Tombstone accretion is handled by **epochs**: last-leave → settle → discard doc; next
  join → fresh doc (new guid) seeded from overlay; optionally re-epoch after commits that
  empty the dirty set. Clients treat an epoch change as a reconnect.
- **Simplifications inherited**: barriers are in-process (same write chain — commit/status/
  reset settle the doc before classifying, trivially); agent-write routing is a map lookup
  in the workspace DO's own doc (touched → splice under agent origin; untouched → overlay
  write + doc entry appears so viewers go live); mounts × sessions rules (pinned bases,
  head-moved, conflicted, transition safety) apply per doc *entry* instead of per session
  DO. The wire is unchanged: yjs-update/awareness as ephemeral events on the **workspace
  stream** (no separate session streams; session-opened/closed facts become
  epoch-started/epoch-settled facts).
- **The honest cost**: one doc means every subscriber receives every touched file's
  content and keystrokes. At tasks/checkout scale that is a feature (live board, recency,
  change badges). Guardrails noted but NOT built in v1: a per-file size threshold above
  which a file gets no Yjs entry (RPC-only editing), and the future option of splitting a
  hot/huge file into its own doc ("session unit is a policy, default = workspace").
- **Rev 1 sections below stand except where they assume per-file session DOs** — read
  "session" as "doc entry", "session DO" as "workspace DO", "session stream" as "workspace
  stream". Contested decision 6 (hash addressing) dissolves entirely. External-requirements
  ledger: drop the `WORKSPACE_SESSION` domain row; everything else stands.

## 1. The model: three tiers, hard boundaries

Every serious precedent (Figma, Zed, Replit, vscode.dev) independently converges on this
split, and it maps 1:1 onto platform primitives:

| Tier | What | Platform primitive |
|---|---|---|
| **Immutable base** | repo content, addressed by oid, fetched lazily per tree/blob | Artifacts (`getTree(oid)`, `getBlob(oid)`) |
| **Settled truth** | the copy-on-write overlay + whiteouts — what git, agents, and status see | Workspace DO (unchanged) |
| **Live sessions** | one Yjs doc per `(workspace, filePath)`, existing only while open | New session DO + its stream |

Nobody runs a repo-wide CRDT. Google Docs = one authoritative server per doc; Figma = one
process per file; Zed = one CRDT per buffer. Our session DO is exactly that grain.

**Authority order for one path's content:**
`live session doc > overlay copy > whiteout > mount repo @ pinned oid`

The overlay is always the settled truth; a live doc is *a checked-out view that owes the
overlay a flush*. Flush **is** `writeFile` — one write path into settled state, inheriting
every existing guard. CRDT history dies at settle points by design; cross-session history is
git's job.

## 2. The one rule that makes agents first-class peers

> **Route agent RPC-fs calls through the session DO when a session is live; straight to the
> overlay otherwise. Semantics of the agent API never change — only merge behavior.**

- `readFile` on a live path returns the doc materialized (read-your-writes holds; agents
  never compute edits against stale text).
- `writeFile`/`edit` on a live path becomes a minimal splice applied as one Yjs transaction
  under `origin: {kind: "agent"}` — the agent merges like any collaborator, human cursors
  survive, per-origin undo means humans can't accidentally undo agent work or vice versa.
- `edit(oldString, newString)` is the friendliest primitive here: content-anchored by
  construction, and "old_string not found" is correct backpressure to a stale agent.

Precedent check: Zed proves the UX (agent edits live buffers, followable, reviewable);
nobody has published agent-via-filesystem-API into live sessions — the session-DO-as-single-
authority is what makes it tractable. This is the genuinely novel piece; prototype early.

## 3. The wire: Yjs rides the streams

Sessions use the platform stream, not a bespoke websocket:

- **Ephemeral events** (eviction-licensed, never folded into durable state):
  `yjs-update {update, clientId}`, `awareness {payload, clientId}` — same traffic class as
  LLM chunk streaming, 1–15ms fan-out via the existing subscribe lane.
- **Durable facts**: `session-opened {path, mode, base}` (birth certificate),
  `flushed {contentHash, stateVector}`, `base-moved {beforeOid, oid, resolution}`,
  `closed {reason}`.
- **`applyUpdate` is an RPC door**: persisted in the session DO storage *before ack*; the
  ephemeral event is fan-out only. Join/reconnect = `sync({stateVector})` against the DO's
  doc, never replay of ephemeral rows.
- Client SDK ships a `StreamYjsProvider` (y-provider interface over open/subscribe/sync/
  applyUpdate). **Exit ramp**: if base64-in-JSON framing runs hot, a binary WS terminating at
  the session DO replaces transport only — semantics unchanged.

## 4. Session lifecycle (industry-consensus flush policy)

- **Open = join** the per-path singleton. Seeds from overlay if dirty, else mount blob —
  and **pins the base** (`{kind: "overlay"}` or `{kind: "mount", baseOid}`; repo `readFile`
  already returns `commitOid`).
- **Two flushes, never conflated**: (a) continuous Yjs update-log persistence in the session
  DO (crash safety only); (b) *settling* — serialize → markdown/source → `writeFile` into
  the overlay, debounced ~2s idle / 15s max (Hocuspocus's proven defaults), plus on
  last-leave, explicit save, and workspace barriers.
- **Close**: final settle, durable `closed` fact, doc state GC'd immediately. Reopen seeds
  fresh. (Optional later: oid-guarded resume — keep the Yjs binary and reuse it iff the
  settled file's hash is unchanged; solves offline-reconnect-after-GC cheaply in a CAS.)
- **Idle close**: no subscribers + no proxy traffic for 5 minutes (DO hibernation friendly).

## 5. Mounts × sessions (the previously under-thought dimension)

- **Base motion is never silent.** `configure` installs a cross-post from each mounted
  repo's stream (`repo/commit-completed` → `workspace/head-moved`). Live sessions react:
  clean doc (never flushed, state vector == seed) → **auto-rebase, loudly** (durable
  `base-moved {resolution: "rebased-clean"}`); dirty doc → flag `conflicted`, wait for
  explicit `session.rebase()` (three-way merge; v1 may ship badge-only).
- **Commit barriers**: `gitCommit` settles every live session under the scoped mount inside
  the write chain, commits, clears overlay, then `rebase-to {commitOid}` re-pins sessions
  (pure re-pin — doc content == committed blob). Post-barrier keystrokes stay in the doc and
  re-dirty on next flush. Nothing lost, nothing torn. `gitStatus` also barriers (settled
  truth must not lie to a committing agent); `readDir` does not (tree paint shouldn't pay
  flush latency).
- **Mount table changes reject, don't juggle**: `assertMountTransitionSafe`'s dirty set
  gains all live session paths — unmount/repoint under an open session fails loudly; close
  sessions and retry.
- **Policy gates the commit door only** (unchanged): sessions on read-only mounts edit
  freely as overlay scratch; failure happens at `gitCommit`, exactly like today.
- `deleteFile` of a live path: delete proceeds (agent semantics unchanged), session
  force-closes *unflushed* (`closed {reason: "file-deleted"}`), registry entry removed
  before whiteout written (no resurrection window).
- `reset`/`revert`: force-close affected sessions without flushing, same write-chain turn.

## 6. Tree, presence, watch

- **`workspace.readDir(path)`** — one level per call, merged from: repo `listTree({oid,
  path})` (new; one Artifacts `getTree` per level, oid-cached), prefix-scoped overlay walk
  (new), whiteout suppression, virtual mount dirs, session annotations
  (`{origin: local|mount|shadowed, dirty, session?}`). **No CRDT tree doc** — the tree is
  derived, server-authoritative. Search-first navigation (fuzzy path index per commit oid +
  overlay delta) is the primary way around 100k files; the tree is orientation UI.
- **Watch = subscribe to the workspace stream.** Durable: `configured` (exists, = mount-
  changed), `head-moved`, `committed {mount, commitOid, changedPaths}` (new),
  `session-opened/closed`. Ephemeral: `files-changed {origin, changes[]}` — coalesced to
  one event per completed write-chain operation, never per keystroke. Contested call:
  file-changed is **ephemeral, not durable** (overlay writes are storage, not facts; durable
  per-write rows would explode the journal under agent workloads; reconnecting clients
  re-list instead of replaying).
- **Presence, two scopes**: workspace scope = the stream's existing subscriber roster +
  focus events (who's here, which file, followable — agents publish the same events humans
  do; follow-the-agent is the transparency mechanism, per Zed); file scope = session
  awareness (cursors/selections).

## 7. Rich text (Docs-style markdown) and code

- **Settled truth is markdown; the rich doc is session-scoped.** Seed = parse markdown →
  ProseMirror/Y.XmlFragment on open; settle = serialize on flush. The alternative
  (Yjs-binary-as-truth) forks reality against the agent API and git. GitBook is the
  precedent: accept **canonicalization** — versioned, deterministic serializer recorded in
  the session birth certificate; second round-trip is byte-stable; `flushed` no-ops on
  unchanged `contentHash` (kills phantom dirtiness).
- **Two modes over the same file**, one live representation per session epoch:
  `mode: "richtext"` (Y.XmlFragment, Tiptap/BlockNote) and `mode: "text"` (Y.Text,
  CodeMirror — also the code-editing mode; y-codemirror.next is mature, y-monaco is not the
  fit). Mode mismatch on open → loud error.
- **Annotations (comments, suggestions) never live in the file's CRDT** — markdown can't
  represent them and settle would destroy them. Sidecar state on the stream, anchored by
  re-attachable text positions. ⚠️ Re-anchoring across settle/re-parse epochs is an
  industry-wide unsolved problem — budget real design time.
- Code settles on-save + debounced autosave; prose settles continuously — same flush
  machinery, different policy.
- Stay on **Yjs v13** (v14 line explicitly unstable).

## 8. Invariants (the arguable core)

1. The overlay is the settled truth; a live doc is a checked-out view that owes it a flush.
2. Agent API semantics are unchanged with or without a session — latency and merge behavior
   change, meaning never does.
3. At most one live doc per (workspace, path); open is a join, never a fork.
4. A session pins its base at open; base motion is an explicit durable event, never a silent
   doc mutation (sole codified exception: clean-doc auto-rebase, itself a durable event).
5. The doc changes only by tagged Yjs transactions (client, agent splice, rebase) — no
   untagged server overwrite.
6. Flush is `writeFile`: one write path to the overlay, no session side door.
7. Per-keystroke traffic is ephemeral; no durable state ever folds a yjs-update/awareness
   row; any loss is recovered by `sync({stateVector})` against the session DO.
8. Settlement barriers run inside the workspace write chain — no operation classifies
   against a doc-stale overlay.
9. An acked `applyUpdate` is durable in the session DO before the ack.
10. Live session paths count as dirty for mount-transition safety.
11. Mount policy gates the commit door only.
12. Closed sessions leave nothing authoritative behind; the session stream survives as audit.

## 9. External requirements ledger

| Requirement | Owner | Status |
|---|---|---|
| Import public GitHub repos server-side | Artifacts | **EXISTS** (PR #2157; no DO clone) |
| `getBlob(oid)` / `getTree(oid)` / `file?ref=&path=` REST reads | Artifacts | **MISSING** — design doc only (`lazy-artifacts-repo-reads.md`, state: todo). **The blocking probe: verify endpoints respond for this account tier.** |
| `repo.readFile` returns `commitOid` (base pinning) | repo DO | EXISTS |
| `repo/commit-completed` incl. external pushes (head-move source) | repo stream | EXISTS |
| `repo.listTree({oid, path})` one-level listing | repo DO | **NEW** (tree objects never deserialized anywhere today) |
| `repo.readFileAt({oid, path})` pinned-oid read (rebase three-way base) | repo DO | **NEW** (head-tree cache is HEAD-only) |
| Cross-post repo→workspace stream (`head-moved` glue at configure time) | workspaces | NEW (crossPostTo itself EXISTS) |
| Ephemeral events, subscribe lane, presence roster | streams | EXISTS |
| Ephemeral eviction sweep | streams | PARTIAL (licensed, unbuilt; session streams make it needed) |
| `WORKSPACE_SESSION` DO + processor contract + session registry + barrier plumbing | workspaces (new sub-domain) | NEW |
| `StreamYjsProvider` in client SDK | client | NEW |
| Prefix-scoped overlay walk | lib/shell-fs | NEW |
| Canonical markdown serializer (versioned) + diff→tree splice for agent writes into richtext | new | NEW — **highest-risk piece, no prior art; prototype first** |

## 10. Contested decisions (argue with these)

1. `files-changed` ephemeral, not durable (journal-bloat vs audit trail).
2. Immediate doc GC at close — no CRDT history across settles (git is history); oid-guarded
   resume as a later, compatible addition.
3. `readFile` on a live path returns the *doc*, not the last flush (read-your-writes chosen
   over settled-only reads).
4. `deleteFile` force-closes unflushed rather than rejecting or flush-then-delete.
5. Yjs over streams rather than dedicated WS (with a transport-only exit ramp).
6. Session stream addressing via hash of (workspacePath, filePath) — ugly but
   collision-safe; readable pair lives in the birth certificate.
7. Clean-doc auto-rebase on head motion (vs pin-forever) — restores float-at-HEAD for
   untouched files at the cost of one codified exception to "no silent doc mutation".
