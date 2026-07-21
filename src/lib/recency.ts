import { useEffect, useState } from "react";
import type * as Y from "yjs";
import {
  checkoutFilesMap,
  collaboratorFor,
  type CollaboratorInfo,
} from "./checkout-shared.ts";

/** How long a touch glows. Ephemeral by design: "recent" means since THIS
 * viewer received the change — Yjs items carry authors, not timestamps. */
export const RECENT_TOUCH_TTL_MS = 90_000;

export type RecentTouch = {
  at: number;
  author: CollaboratorInfo;
  action: "added" | "edited" | "deleted";
};

/** One recently-inserted run of characters, in file coordinates. */
export type RecentSpan = { from: number; to: number; author: CollaboratorInfo; at: number };

export type RecencyState = {
  /** Last touch per task path — the card ring + hover line. */
  touches: Map<string, RecentTouch>;
  /** Recent insert ranges per task path — card text highlighting. */
  spans: Map<string, RecentSpan[]>;
};

const EMPTY: RecencyState = { touches: new Map(), spans: new Map() };

/**
 * Watch the files map and remember who touched which task when — both as a
 * per-path "last touch" and as character ranges of recent insertions
 * (remapped through subsequent edits, so highlights stay glued to their
 * text). Own edits glow too. Everything expires after the TTL.
 */
export function useRecentTouches(doc: Y.Doc | null, active: boolean): RecencyState {
  const [state, setState] = useState<RecencyState>(EMPTY);

  useEffect(() => {
    if (doc === null || !active) return;
    const files = checkoutFilesMap(doc);
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (next: RecencyState) => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      let soonest = Infinity;
      for (const touch of next.touches.values()) {
        soonest = Math.min(soonest, touch.at + RECENT_TOUCH_TTL_MS);
      }
      if (soonest !== Infinity) {
        timer = setTimeout(prune, Math.max(250, soonest - Date.now() + 50));
      }
    };
    const prune = () => {
      setState((previous) => {
        const now = Date.now();
        const touches = new Map(
          [...previous.touches].filter(([, touch]) => now - touch.at < RECENT_TOUCH_TTL_MS),
        );
        const spans = new Map<string, RecentSpan[]>();
        for (const [path, list] of previous.spans) {
          const kept = list.filter((span) => now - span.at < RECENT_TOUCH_TTL_MS);
          if (kept.length > 0) spans.set(path, kept);
        }
        const next = { touches, spans };
        schedule(next);
        return next;
      });
    };

    const observer = (
      events: Array<Y.YEvent<Y.AbstractType<unknown>>>,
      transaction: Y.Transaction,
    ) => {
      const author = transactionAuthor(doc, transaction);
      if (author === null) return;
      const now = Date.now();
      setState((previous) => {
        const touches = new Map(previous.touches);
        const spans = new Map(previous.spans);
        for (const event of events) {
          if (event.target === (files as unknown)) {
            const mapEvent = event as unknown as Y.YMapEvent<unknown>;
            for (const key of mapEvent.keysChanged) {
              const change = mapEvent.changes.keys.get(key);
              const action =
                change?.action === "delete"
                  ? "deleted"
                  : change?.action === "add"
                    ? "added"
                    : "edited";
              touches.set(key, { at: now, author, action });
              if (action === "deleted") {
                spans.delete(key);
              } else {
                // A set is a whole-content write (new file or replacement):
                // the entire text is this author's fresh insertion.
                const length = files.get(key)?.toString().length ?? 0;
                spans.set(key, length > 0 ? [{ from: 0, to: length, author, at: now }] : []);
              }
            }
          } else if (typeof event.path[0] === "string") {
            const path = event.path[0];
            touches.set(path, { at: now, author, action: "edited" });
            const remapped = remapSpans(spans.get(path) ?? [], event.delta);
            let index = 0;
            for (const op of event.delta) {
              if (typeof op.retain === "number") index += op.retain;
              else if (typeof op.insert === "string") {
                remapped.push({ from: index, to: index + op.insert.length, author, at: now });
                index += op.insert.length;
              }
            }
            spans.set(path, remapped);
          }
        }
        const next = { touches, spans };
        schedule(next);
        return next;
      });
    };

    files.observeDeep(observer);
    return () => {
      files.unobserveDeep(observer);
      if (timer !== null) clearTimeout(timer);
    };
  }, [doc, active]);

  return state;
}

/** Shift existing spans through one Yjs text delta so they track their text. */
function remapSpans(
  spans: RecentSpan[],
  delta: Array<{ retain?: number; insert?: string | object; delete?: number }>,
): RecentSpan[] {
  let mapped = spans.map((span) => ({ ...span }));
  let index = 0;
  for (const op of delta) {
    if (typeof op.retain === "number") {
      index += op.retain;
    } else if (typeof op.insert === "string") {
      const length = op.insert.length;
      for (const span of mapped) {
        if (span.from >= index) span.from += length;
        if (span.to > index) span.to += length;
      }
      index += length;
    } else if (typeof op.delete === "number") {
      const length = op.delete;
      const shrink = (position: number) =>
        position <= index ? position : Math.max(index, position - length);
      for (const span of mapped) {
        span.from = shrink(span.from);
        span.to = shrink(span.to);
      }
      mapped = mapped.filter((span) => span.to > span.from);
    }
  }
  return mapped;
}

/**
 * The single client behind one transaction, when it is unambiguous.
 * Writers are whoever's state-vector clock advanced (covers map sets whose
 * fresh subtrees never appear in `changes.added`); pure deletions fall back
 * to the transaction's delete set.
 */
export function transactionAuthor(doc: Y.Doc, transaction: Y.Transaction): CollaboratorInfo | null {
  const clients = new Set<number>();
  for (const [client, clock] of transaction.afterState) {
    if (transaction.beforeState.get(client) !== clock) clients.add(client);
  }
  if (clients.size === 0) {
    for (const client of transaction.deleteSet.clients.keys()) clients.add(client);
  }
  if (clients.size !== 1) return null;
  return collaboratorFor(doc, [...clients][0]!);
}

export function agoText(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
}
