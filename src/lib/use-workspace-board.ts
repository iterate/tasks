import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { withProject } from "./use-checkout.ts";
import type { TasksWorkspace } from "./tasks-api.ts";
import type { TaskChangeStatus } from "../state.ts";
import { isTaskFilePath } from "../tasks-model.ts";
import { toBoardTask, type BoardTask } from "./board-model.ts";

/**
 * The board's data layer on the WORKSPACE mechanism: the platform overlay is
 * the single source of truth (no Y.Doc, no base snapshot — `status()` IS the
 * diff). Reads seed from `files()`; liveness is a light status poll that
 * refetches only changed paths; every mutation is the same write an agent
 * would make, applied optimistically and confirmed by the poll.
 */

const POLL_MS = 3500;

/** ONE key form for everything the board holds: repo-relative, no leading
 * slash — the same shape the Yjs lane's task paths and isTaskFilePath use.
 * The platform returns absolute paths from glob/status; writes go back
 * absolute. Mixing forms silently splits sessions and misses badges. */
export function boardKey(path: string): string {
  return path.replace(/^\/+/, "");
}

type WorkspaceStatusShape = {
  mounts?: { changes?: { change: string; path: string }[] }[];
};

export function changeMap(status: unknown): Map<string, TaskChangeStatus> {
  const map = new Map<string, TaskChangeStatus>();
  for (const mount of (status as WorkspaceStatusShape).mounts ?? []) {
    for (const entry of mount.changes ?? []) {
      if (!isTaskFilePath(entry.path)) continue;
      const kind =
        entry.change === "added" ? "added" : entry.change === "deleted" ? "deleted" : "modified";
      map.set(boardKey(entry.path), kind);
    }
  }
  return map;
}

export function useWorkspaceBoard(checkoutId: string, repoPath: string) {
  const [files, setFiles] = useState<Record<string, string> | null>(null);
  const [changes, setChanges] = useState<Map<string, TaskChangeStatus>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const lane = useCallback(
    <T,>(operation: (ws: TasksWorkspace) => Promise<T>) =>
      withProject((project) =>
        operation(
          (project as { workspace(c: string, r?: string): unknown }).workspace(
            checkoutId,
            repoPath,
          ) as TasksWorkspace,
        ),
      ),
    [checkoutId, repoPath],
  );

  // Initial seed: the whole task file set + dirty state, in parallel.
  useEffect(() => {
    const mine = ++generation.current;
    setFiles(null);
    setError(null);
    void Promise.all([lane((ws) => ws.files()), lane((ws) => ws.status())])
      .then(([seeded, status]) => {
        if (generation.current !== mine) return;
        setFiles(Object.fromEntries(Object.entries(seeded).map(([path, c]) => [boardKey(path), c])));
        setChanges(changeMap(status));
      })
      .catch((cause: unknown) => {
        if (generation.current !== mine) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      generation.current++;
    };
  }, [lane]);

  // Liveness: the collab VERSION map is the change cursor — a path whose
  // head advanced gets refetched even when its status kind is unchanged
  // (modified → modified was invisible to a kind-only diff). Status refreshes
  // badges on the same tick; poll errors surface instead of vanishing.
  const versionsRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const mine = generation.current;
    const timer = setInterval(() => {
      void Promise.all([lane((ws) => ws.versions()), lane((ws) => ws.status())])
        .then(async ([rawVersions, status]) => {
          if (generation.current !== mine) return;
          const next = changeMap(status);
          const versions = Object.fromEntries(
            Object.entries(rawVersions).map(([path, version]) => [boardKey(path), version]),
          );
          const moved = new Set<string>();
          for (const [path, version] of Object.entries(versions)) {
            if (versionsRef.current[path] !== version) moved.add(path);
          }
          for (const [path, kind] of next) if (changes.get(path) !== kind) moved.add(path);
          for (const path of changes.keys()) if (!next.has(path)) moved.add(path);
          versionsRef.current = versions;
          if (moved.size === 0) return;
          const fetched = await Promise.all(
            [...moved].map(
              async (path) => [boardKey(path), await lane((ws) => ws.read(`/${boardKey(path)}`))] as const,
            ),
          );
          if (generation.current !== mine) return;
          setChanges(next);
          setFiles((current) => {
            if (current === null) return current;
            const merged = { ...current };
            for (const [path, content] of fetched) {
              if (content === null) delete merged[path];
              else merged[path] = content;
            }
            return merged;
          });
        })
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        );
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [lane, changes]);

  const tasks = useMemo<BoardTask[]>(() => {
    if (files === null) return [];
    return Object.entries(files)
      .filter(([path]) => isTaskFilePath(path))
      .map(([path, source]) => toBoardTask(path, source))
      .sort((left, right) => left.path.localeCompare(right.path));
  }, [files]);

  /** Optimistic local write + the same platform write an agent would make. */
  const writeTask = useCallback(
    (path: string, content: string) => {
      setFiles((current) => (current === null ? current : { ...current, [path]: content }));
      setChanges((current) => new Map(current).set(path, current.get(path) ?? "modified"));
      void lane((ws) => ws.write(`/${path}`, content)).catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    [lane],
  );

  const deleteTask = useCallback(
    (path: string) => {
      setFiles((current) => {
        if (current === null) return current;
        const { [path]: _gone, ...rest } = current;
        return rest;
      });
      void lane((ws) => ws.delete(`/${path}`)).catch(() => {});
    },
    [lane],
  );

  /** Live content from an open editor session — keeps the card current
   * while typing without waiting for the flush + poll round trip. */
  const reflectLiveContent = useCallback((path: string, content: string) => {
    setFiles((current) =>
      current === null || current[path] === content ? current : { ...current, [path]: content },
    );
  }, []);

  const commit = useCallback(
    async (message: string) => {
      const result = await lane((ws) => ws.commit(message));
      const [seeded, status] = await Promise.all([
        lane((ws) => ws.files()),
        lane((ws) => ws.status()),
      ]);
      setFiles(seeded);
      setChanges(changeMap(status));
      return result;
    },
    [lane],
  );

  return {
    changes,
    commit,
    deleteTask,
    error,
    files,
    ready: files !== null,
    reflectLiveContent,
    tasks,
    writeTask,
  };
}
