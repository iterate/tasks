import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { withProject } from "./use-checkout.ts";
import type { TasksWorkspace, WorkspaceStreamEvent } from "./tasks-api.ts";
import type { TaskChangeStatus, TaskChangeSummary } from "../state.ts";
import { isTaskFilePath, parseTaskCard } from "../tasks-model.ts";
import { changeAfterDelete, changeAfterWrite, toBoardTask, type BoardTask } from "./board-model.ts";

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
  const tickRef = useRef(0);
  // Bumped by EVERY local mutation (writes, deletes, live keystrokes,
  // reverts, commits): an in-flight poll response from before the mutation
  // must not overwrite newer local state — badges OR file content. The next
  // tick reconciles with server truth.
  const mutationEpoch = useRef(0);
  useEffect(() => {
    const mine = generation.current;
    const timer = setInterval(() => {
      // versions() is a cheap map read; status() runs the settle barrier and
      // git classification — polling THAT every tick makes the whole page
      // pay a platform barrier per few seconds. Badges refresh on a slower
      // cadence and after mutations/commits.
      const wantStatus = tickRef.current++ % 4 === 0;
      const epochBefore = mutationEpoch.current;
      void Promise.all([
        lane((ws) => ws.versions()),
        wantStatus ? lane((ws) => ws.status()) : Promise.resolve(null),
      ])
        .then(async ([rawVersions, status]) => {
          if (generation.current !== mine) return;
          const next = status === null ? changes : changeMap(status);
          const versions = Object.fromEntries(
            Object.entries(rawVersions).map(([path, version]) => [boardKey(path), version]),
          );
          const moved = new Set<string>();
          for (const [path, version] of Object.entries(versions)) {
            if (versionsRef.current[path] !== version) moved.add(path);
          }
          if (status !== null) {
            for (const [path, kind] of next) if (changes.get(path) !== kind) moved.add(path);
            for (const path of changes.keys()) if (!next.has(path)) moved.add(path);
          }
          if (moved.size === 0) {
            versionsRef.current = versions;
            return;
          }
          const fetched = await Promise.all(
            [...moved].map(
              async (path) => [boardKey(path), await lane((ws) => ws.read(`/${boardKey(path)}`))] as const,
            ),
          );
          if (generation.current !== mine) return;
          // One epoch check for BOTH maps: fetched content that started
          // before a local mutation is as stale as its badges. Bail BEFORE
          // recording versions — a skipped tick must leave the cursor
          // behind so the next tick re-detects (and re-fetches) the paths.
          if (mutationEpoch.current !== epochBefore) return;
          versionsRef.current = versions;
          if (status !== null) setChanges(next);
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

  // Per-file parse cache: a poll refetch or one live keystroke must cost
  // O(changed files), never a reparse of the whole board.
  const parseCache = useRef(new Map<string, { source: string; task: BoardTask }>());
  const tasks = useMemo<BoardTask[]>(() => {
    if (files === null) return [];
    const cache = parseCache.current;
    const next: BoardTask[] = [];
    for (const [path, source] of Object.entries(files)) {
      if (!isTaskFilePath(path)) continue;
      const cached = cache.get(path);
      if (cached !== undefined && cached.source === source) {
        next.push(cached.task);
        continue;
      }
      const task = toBoardTask(path, source);
      cache.set(path, { source, task });
      next.push(task);
    }
    if (cache.size > next.length * 2) {
      for (const key of cache.keys()) if (files[key] === undefined) cache.delete(key);
    }
    return next.sort((left, right) => left.path.localeCompare(right.path));
  }, [files]);

  /** Optimistic local write + the same platform write an agent would make. */
  const writeTask = useCallback(
    (path: string, content: string) => {
      mutationEpoch.current++;
      setFiles((current) => {
        // The transition needs to know if the path existed BEFORE this write
        // (unknown path = an ADD, not a modification), so status updates
        // inside the same setter that sees the pre-write files.
        setChanges((changes) =>
          new Map(changes).set(
            path,
            changeAfterWrite(changes.get(path), current?.[path] !== undefined),
          ),
        );
        return current === null ? current : { ...current, [path]: content };
      });
      void lane((ws) => ws.write(`/${path}`, content)).catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    [lane],
  );

  const deleteTask = useCallback(
    (path: string) => {
      mutationEpoch.current++;
      setFiles((current) => {
        if (current === null) return current;
        const { [path]: _gone, ...rest } = current;
        return rest;
      });
      // Deleted cards belong on the Deleted strip immediately — and deleting
      // an uncommitted add erases the change instead of leaving a phantom.
      setChanges((current) => {
        const next = new Map(current);
        const transitioned = changeAfterDelete(current.get(path));
        if (transitioned === null) next.delete(path);
        else next.set(path, transitioned);
        return next;
      });
      void lane((ws) => ws.delete(`/${path}`)).catch(() => {});
    },
    [lane],
  );

  /** Live content from an open editor session — keeps the card current
   * while typing without waiting for the flush + poll round trip. */
  const reflectLiveContent = useCallback((path: string, content: string) => {
    mutationEpoch.current++;
    setFiles((current) => {
      if (current === null || current[path] === content) return current;
      // A live edit IS dirtiness: commit controls must arm on the first
      // keystroke, not on the next status poll.
      setChanges((changes) =>
        changes.has(path)
          ? changes
          : new Map(changes).set(path, changeAfterWrite(undefined, current[path] !== undefined)),
      );
      return { ...current, [path]: content };
    });
  }, []);

  /** One file's merged-view content (the live head when a session is open). */
  const readTask = useCallback(
    (path: string) => lane((ws) => ws.read(`/${path}`)),
    [lane],
  );

  /**
   * Rename = optimistic swap, but the DELETE waits for the write to land:
   * a failed create must roll the board back, never drop the source file.
   * `carry` folds a final-frame keystroke (still on the dying session) onto
   * the new path before the delete discards that session.
   */
  const renameTask = useCallback(
    async (
      fromPath: string,
      toPath: string,
      content: string,
      carry: (finalSource: string) => string = (source) => source,
    ): Promise<boolean> => {
      mutationEpoch.current++;
      let fromContent: string | undefined;
      let fromChange: TaskChangeStatus | undefined;
      setChanges((current) => {
        fromChange = current.get(fromPath);
        const next = new Map(current);
        next.set(toPath, changeAfterWrite(current.get(toPath), false));
        const transitioned = changeAfterDelete(current.get(fromPath));
        if (transitioned === null) next.delete(fromPath);
        else next.set(fromPath, transitioned);
        return next;
      });
      setFiles((current) => {
        if (current === null) return current;
        fromContent = current[fromPath];
        const { [fromPath]: _gone, ...rest } = current;
        return { ...rest, [toPath]: content };
      });
      try {
        await lane((ws) => ws.write(`/${toPath}`, content));
      } catch (cause) {
        mutationEpoch.current++;
        setFiles((current) => {
          if (current === null) return current;
          const { [toPath]: _added, ...rest } = current;
          return fromContent === undefined ? rest : { ...rest, [fromPath]: fromContent };
        });
        setChanges((current) => {
          const next = new Map(current);
          next.delete(toPath);
          if (fromChange === undefined) next.delete(fromPath);
          else next.set(fromPath, fromChange);
          return next;
        });
        setError(cause instanceof Error ? cause.message : String(cause));
        return false;
      }
      try {
        const final = await lane((ws) => ws.read(`/${fromPath}`));
        if (final !== null) {
          const carried = carry(final);
          if (carried !== content) {
            await lane((ws) => ws.write(`/${toPath}`, carried));
            mutationEpoch.current++;
            setFiles((current) =>
              current === null ? current : { ...current, [toPath]: carried },
            );
          }
        }
      } catch {
        // The carry is best-effort; the source still gets deleted below.
      }
      void lane((ws) => ws.delete(`/${fromPath}`)).catch(() => {});
      return true;
    },
    [lane],
  );

  /** Change summaries in the shape the commit controls speak. */
  const taskChanges = useMemo<TaskChangeSummary[]>(
    () =>
      [...changes.entries()]
        .map(([path, status]) => ({
          path,
          status,
          title:
            files?.[path] !== undefined
              ? parseTaskCard(path, files[path]).title
              : (path.split("/").at(-1) ?? path),
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    [changes, files],
  );

  /** Back to the mount's version — restore a delete, drop an add, undo edits. */
  const revertTask = useCallback(
    (path: string) => {
      mutationEpoch.current++;
      void lane(async (ws) => {
        await ws.revert(`/${path}`);
        mutationEpoch.current++;
        const content = await ws.read(`/${path}`);
        setFiles((current) => {
          if (current === null) return current;
          const merged = { ...current };
          if (content === null) delete merged[path];
          else merged[path] = content;
          return merged;
        });
        setChanges((current) => {
          const next = new Map(current);
          next.delete(path);
          return next;
        });
      }).catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    [lane],
  );

  const discardAll = useCallback(() => {
    for (const path of changes.keys()) revertTask(path);
  }, [changes, revertTask]);

  const commit = useCallback(
    async (message: string) => {
      mutationEpoch.current++;
      const result = await lane((ws) => ws.commit(message));
      const [seeded, status] = await Promise.all([
        lane((ws) => ws.files()),
        lane((ws) => ws.status()),
      ]);
      // The refetch is the fresh truth; bump again so a poll that started
      // mid-commit can't wipe the post-commit clean state.
      mutationEpoch.current++;
      // Same key normalization as the seed — mixed-shape keys would orphan
      // badges and duplicate cards after the first commit.
      setFiles(Object.fromEntries(Object.entries(seeded).map(([path, c]) => [boardKey(path), c])));
      setChanges(changeMap(status));
      return result;
    },
    [lane],
  );

  const subscribeEvents = useCallback(
    (onBatch: (events: WorkspaceStreamEvent[]) => void) =>
      lane((ws) => ws.subscribeEvents((batch) => onBatch(batch.events))),
    [lane],
  );

  return {
    changes,
    commit,
    deleteTask,
    discardAll,
    error,
    files,
    subscribeEvents,
    ready: files !== null,
    readTask,
    reflectLiveContent,
    renameTask,
    revertTask,
    taskChanges,
    tasks,
    writeTask,
  };
}
