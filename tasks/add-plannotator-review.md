---
status: ready
size: large
base: collab-poc
---

# Add multiplayer Plannotator review to workspace tasks

## Status

0% complete. The integration contract is specified; implementation and browser proof remain.

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

- [ ] Add the Plannotator packages, styles, and a client-only review surface.
- [ ] Add a public workspace annotation API backed by durable stream events.
- [ ] Prove a snapshot folds add/update/remove events for one task without leaking another task's annotations.
- [ ] Prove the browser transport cannot spoof the verified annotation author.
- [ ] Add Review/Edit switching to the workspace task sheet without replacing the live editor.
- [ ] Show live annotations in Plannotator's Viewer and AnnotationPanel, including edit/delete.
- [ ] Verify typecheck, tests, production build, and a two-browser local multiplayer flow.

## Implementation log

- 2026-07-22: Chose the existing workspace stream as the annotation journal. This avoids a second
  storage system and makes review activity visible in the checkout's existing event audit sheet.
