import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import YProvider from "y-partyserver/provider";
import type { CommitResult, TaskChangeSummary } from "../state.ts";
import { DEFAULT_REPO_PATH } from "./checkout-shared.ts";

export type CheckoutStatus = "connecting" | "connected" | "ready" | "disconnected";

/**
 * The browser's end of a collaborative checkout: a stock y-partyserver
 * YProvider (the y-websocket wire) pointed at `/api/checkout/<id>`, carrying
 * the shared Y.Doc and everyone's presence. Auth is invisible here — the
 * project proxy stamps the session cookie on the upgrade like any request.
 */
export function useCheckout(checkoutId: string, repoPath: string) {
  const [handle, setHandle] = useState<{ provider: YProvider; doc: Y.Doc } | null>(null);

  useEffect(() => {
    const doc = new Y.Doc();
    // Change counter for useSyncExternalStore (the state vector alone would
    // miss deletions). Registered before any subscriber so it bumps first.
    doc.on("update", () => docVersions.set(doc, (docVersions.get(doc) ?? 0) + 1));
    const provider = new YProvider(window.location.host, `${repoPath}:${checkoutId}`, doc, {
      prefix: `/api/checkout/${encodeURIComponent(checkoutId)}`,
      params: { repoPath },
    });
    provider.awareness.setLocalStateField("user", localCollabUser());
    setHandle({ provider, doc });
    return () => {
      setHandle(null);
      provider.destroy();
      doc.destroy();
    };
  }, [checkoutId, repoPath]);

  const provider = handle?.provider ?? null;
  const doc = handle?.doc ?? null;

  const subscribeStatus = useCallback(
    (listener: () => void) => {
      if (!provider) return () => {};
      provider.on("status", listener);
      provider.on("sync", listener);
      return () => {
        provider.off("status", listener);
        provider.off("sync", listener);
      };
    },
    [provider],
  );
  const status = useSyncExternalStore<CheckoutStatus>(
    subscribeStatus,
    () => {
      if (!provider) return "connecting";
      if (provider.synced) return "ready";
      if (provider.wsconnected) return "connected";
      return provider.wsconnecting ? "connecting" : "disconnected";
    },
    () => "connecting",
  );

  const subscribeDoc = useCallback(
    (listener: () => void) => {
      if (!doc) return () => {};
      const onUpdate = () => listener();
      doc.on("update", onUpdate);
      return () => doc.off("update", onUpdate);
    },
    [doc],
  );
  const docVersion = useSyncExternalStore(
    subscribeDoc,
    () => (doc ? (docVersions.get(doc) ?? 0) : 0),
    () => 0,
  );

  const subscribeAwareness = useCallback(
    (listener: () => void) => {
      if (!provider) return () => {};
      const onChange = () => listener();
      provider.awareness.on("change", onChange);
      return () => provider.awareness.off("change", onChange);
    },
    [provider],
  );
  const awarenessVersion = useSyncExternalStore(
    subscribeAwareness,
    () => {
      if (!provider) return "";
      return [...provider.awareness.getStates().entries()]
        .map(([id, state]) => `${id}:${JSON.stringify(state)}`)
        .sort()
        .join("|");
    },
    () => "",
  );

  return { provider, doc, status, docVersion, awarenessVersion };
}

const docVersions = new WeakMap<Y.Doc, number>();

/** POST a git op to the checkout's DO. Cookies (auth) ride along same-origin. */
async function postCheckoutOp<T>(
  checkoutId: string,
  repoPath: string,
  op: "commit" | "generate-message",
  body: { message?: string; changes?: TaskChangeSummary[] },
): Promise<T> {
  const query = repoPath === DEFAULT_REPO_PATH ? "" : `?repoPath=${encodeURIComponent(repoPath)}`;
  const response = await fetch(`/api/checkout/${encodeURIComponent(checkoutId)}/${op}${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

export function commitCheckoutOp(
  checkoutId: string,
  repoPath: string,
  message: string,
): Promise<CommitResult> {
  return postCheckoutOp<CommitResult>(checkoutId, repoPath, "commit", { message });
}

export function generateCheckoutMessageOp(
  checkoutId: string,
  repoPath: string,
  changes: TaskChangeSummary[],
): Promise<string> {
  return postCheckoutOp<string>(checkoutId, repoPath, "generate-message", { changes });
}

/** The project's repos, for the landing-page picker. */
export async function listRepos(): Promise<string[]> {
  const response = await fetch("/api/checkout-repos");
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as string[];
}

/** The identity this browser collaborates as — persisted locally, renameable. */
export type CollabUser = { name: string; color: string; colorLight: string };

const IDENTITY_KEY = "tasks-collab-identity";
const COLORS = [
  "#6fbf8f",
  "#d9a05b",
  "#8b93e6",
  "#e08a92",
  "#5bc0d9",
  "#c78be6",
  "#a8c76b",
  "#e6b35b",
];
const ADJECTIVES = ["brisk", "calm", "deft", "keen", "merry", "quick", "sly", "warm"];
const ANIMALS = ["fox", "heron", "lynx", "otter", "raven", "seal", "stoat", "wren"];

export function localCollabUser(): CollabUser {
  try {
    const stored = window.localStorage.getItem(IDENTITY_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<CollabUser>;
      if (typeof parsed.name === "string" && typeof parsed.color === "string") {
        return { name: parsed.name, color: parsed.color, colorLight: `${parsed.color}55` };
      }
    }
  } catch {
    // fall through to a fresh identity
  }
  const name = `${pick(ADJECTIVES)} ${pick(ANIMALS)}`;
  const color = pick(COLORS);
  const user = { name, color, colorLight: `${color}55` };
  try {
    window.localStorage.setItem(IDENTITY_KEY, JSON.stringify({ name, color }));
  } catch {
    // private mode — identity just won't persist
  }
  return user;
}

export function renameCollabUser(provider: YProvider, name: string): CollabUser {
  const current = localCollabUser();
  const user = { ...current, name: name.trim() || current.name };
  try {
    window.localStorage.setItem(IDENTITY_KEY, JSON.stringify({ name: user.name, color: user.color }));
  } catch {
    // ignore
  }
  provider.awareness.setLocalStateField("user", user);
  return user;
}

function pick<T>(values: readonly T[]): T {
  return values[Math.floor(Math.random() * values.length)]!;
}
