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

/**
 * Watch the files map for touches and remember, per task path, who touched
 * it last and when. Authors come from the transaction's own state-vector
 * diff (deletions from its delete set), resolved through the doc's
 * collaborators map. Own edits glow too — same as everyone else's, so the
 * feature is visible even solo. Entries expire after the TTL.
 */
export function useRecentTouches(doc: Y.Doc | null, active: boolean): Map<string, RecentTouch> {
  const [touches, setTouches] = useState<Map<string, RecentTouch>>(() => new Map());

  useEffect(() => {
    if (doc === null || !active) return;
    const files = checkoutFilesMap(doc);
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (map: Map<string, RecentTouch>) => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      let soonest = Infinity;
      for (const touch of map.values()) soonest = Math.min(soonest, touch.at + RECENT_TOUCH_TTL_MS);
      if (soonest !== Infinity) {
        timer = setTimeout(prune, Math.max(250, soonest - Date.now() + 50));
      }
    };
    const prune = () => {
      setTouches((previous) => {
        const now = Date.now();
        const next = new Map(
          [...previous].filter(([, touch]) => now - touch.at < RECENT_TOUCH_TTL_MS),
        );
        schedule(next);
        return next;
      });
    };

    const observer = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>, transaction: Y.Transaction) => {
      const author = transactionAuthor(doc, transaction);
      if (author === null) return;
      const now = Date.now();
      const updates: Array<[string, RecentTouch]> = [];
      for (const event of events) {
        if (event.target === (files as unknown)) {
          const mapEvent = event as unknown as Y.YMapEvent<unknown>;
          for (const key of mapEvent.keysChanged) {
            const change = mapEvent.changes.keys.get(key);
            const action =
              change?.action === "delete" ? "deleted" : change?.action === "add" ? "added" : "edited";
            updates.push([key, { at: now, author, action }]);
          }
        } else if (typeof event.path[0] === "string") {
          updates.push([event.path[0], { at: now, author, action: "edited" }]);
        }
      }
      if (updates.length > 0) {
        setTouches((previous) => {
          const next = new Map(previous);
          for (const [path, touch] of updates) next.set(path, touch);
          schedule(next);
          return next;
        });
      }
    };

    files.observeDeep(observer);
    return () => {
      files.unobserveDeep(observer);
      if (timer !== null) clearTimeout(timer);
    };
  }, [doc, active]);

  return touches;
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
