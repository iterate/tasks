---
status: complete
size: large
base: collab-poc
---

# Add multiplayer Plannotator review to workspace tasks

## Status

Complete. Workspace task sheets now have an Iterate-backed Plannotator review mode with durable,
live annotations, verified authors, and browser proof across two isolated reviewers. The existing
collaborative editor remains intact; upstream package size/source-mode cost is noted below.

## Outcome

The workspace-backed task sheet offers an Edit/Review switch. Review renders the task with
Plannotator's published document UI and lets project members attach comments or deletion
suggestions to selected text. Review annotations are durable, live multiplayer state backed by
the checkout's Iterate workspace stream. The existing collaborative editor remains the source
of task markdown.

## Decisions

- Build on `collab-poc`; the checkout is already an Iterate workspace and agents keep using the
  standard workspace API.
- Consume `@plannotator/ui` and `@plannotator/core`; do not copy or reimplement their document UI.
- Store annotation mutations as namespaced durable events on the workspace stream. Fold those
  events for snapshots and replay from the snapshot offset for race-free live subscription.
- Scope every annotation to a workspace-relative task path. Renaming a task does not silently
  move its review history in this slice; the old path's history remains auditable.
- Stamp annotation authors in the vessel from the already-verified Iterate session, ignoring a
  client-supplied author.
- Keep task markdown editing in the existing collaborative CodeMirror lane. Review mode reads its
  live reflected content and annotations verify restored text after document drift.
- Load Plannotator only in the browser: its package-level configuration is not SSR-safe.
- Images and AI are out of scope; their UI affordances stay disabled.

## Checklist

- [x] Add the Plannotator packages, styles, and a client-only review surface. *Pinned the published packages and lazy-loaded the review-only bundle.*
- [x] Add a public workspace annotation API backed by durable stream events. *`TasksWorkspace` now appends and folds namespaced Plannotator events on the workspace stream.*
- [x] Prove a snapshot folds add/update/remove events for one task without leaking another task's annotations. *Covered by `workspace-annotations.test.ts`.*
- [x] Prove the browser transport cannot spoof the verified annotation author. *The journal spec submits Mallory and observes server-stamped Ada.*
- [x] Add Review/Edit switching to the workspace task sheet without replacing the live editor. *The selected view and annotation live in route search state.*
- [x] Show live annotations in Plannotator's Viewer and AnnotationPanel, including edit/delete. *Viewer selection, global comments, panel edits, deletes, and agent-feedback copy are wired.*
- [x] Verify typecheck, tests, production build, and a two-browser local multiplayer flow. *All static checks pass; the built Worker proved live create/edit/delete, refresh durability, and exact-text comments on localhost.*

## Implementation log

- 2026-07-22: Chose the existing workspace stream as the annotation journal. This avoids a second
  storage system and makes review activity visible in the checkout's existing event audit sheet.
- 2026-07-22: Added a browser WebSocket OPEN barrier after localhost exposed the collab PoC's
  startup race. Application errors no longer dispose the shared Cap'n Web session for every caller.
- 2026-07-22: Patched `@plannotator/ui@0.28.0` locally for TypeScript 5.9 response typing and its
  `highlight.js` ESM/CJS boundary; the patch is explicit in `patches/` and can be dropped after an
  upstream release contains equivalent fixes.
- 2026-07-22: Verified the built Worker at localhost with two isolated headed browsers. One browser
  saw the other's new and edited annotations without reload; refresh restored durable state; a
  selected-text comment retained the exact quote `Select this sentence` and the verified author.
- 2026-07-22: Plannotator's rich Viewer remains a lazy ~1 MB gzip chunk and its published source
  makes Vite's first source-mode review compile expensive. Edit/board startup is unaffected; a
  slimmer upstream document-only entrypoint would be the clean follow-up.
