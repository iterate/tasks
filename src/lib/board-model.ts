import type { TaskCard } from "../state.ts";
import type { TaskChangeStatus } from "../state.ts";
import { parseTaskCard } from "../tasks-model.ts";

/** A card plus what the board needs to place and preview it. */
export type BoardTask = TaskCard & {
  /** Grouping key: "/" for files directly under tasks/, else "/sub/dir". */
  folder: string;
  /** First body line after the heading, for the card's excerpt. */
  summary: string;
  /** Source offset of the rendered title (null when not from the heading). */
  titleFrom: number | null;
  /** Source offset of the summary line's first rendered character. */
  summaryFrom: number;
};

export type PresenceUser = { name: string; color: string };

/** Board swimlane grouping: folder rows, tag rows, or one flat row. */
export type RowField = "folder" | "label" | null;

/** One remote collaborator, as read from Yjs awareness. */
export type Peer = {
  id: number;
  user: PresenceUser;
  email?: string;
  userId?: string;
  image?: string;
  openPath: string | null;
};

export function stateLabel(state: string): string {
  switch (state) {
    case "todo":
      return "Todo";
    case "in-progress":
      return "In progress";
    case "in-review":
      return "In review";
    case "done":
      return "Done";
    default:
      return state;
  }
}

export function toBoardTask(path: string, source: string): BoardTask {
  const card = parseTaskCard(path, source);
  const summary = taskSummary(source);
  return {
    ...card,
    folder: taskFolder(path),
    summary: summary.text,
    summaryFrom: summary.from,
    titleFrom: titleOffset(source, card.title),
  };
}

/** Where the heading-derived title starts in the source, for highlighting. */
function titleOffset(source: string, title: string): number | null {
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(source);
  if (heading === null || heading[1] !== title) return null;
  return heading.index + heading[0].indexOf(heading[1]!);
}

/** The path segments between the `tasks` directory and the filename. */
export function taskFolder(path: string): string {
  // The folder is the prefix BEFORE the tasks/ segment:
  //   tasks/x.md              → "/"
  //   some/folder/tasks/x.md  → "some/folder"
  //   bla/tasks/x.md          → "bla"
  // (Segments after tasks/ stay part of the filename grouping-wise.)
  const segments = path.split("/").filter(Boolean);
  const tasksIndex = segments.lastIndexOf("tasks");
  const before = tasksIndex <= 0 ? [] : segments.slice(0, tasksIndex);
  return before.length === 0 ? "/" : before.join("/");
}

/** Rebuild a task's path for a (possibly different) folder, keeping the
 * filename and any subpath below tasks/. Always emits a NORMALIZED path —
 * split/filter makes double slashes unrepresentable. */
export function taskPathInFolder(path: string, folder: string): string {
  const segments = path.split("/").filter(Boolean);
  const tasksIndex = segments.lastIndexOf("tasks");
  const below = segments.slice(tasksIndex + 1);
  const prefix = folder
    .split("/")
    .filter(Boolean)
    .filter((segment) => segment !== "/");
  return [...prefix, "tasks", ...below].join("/");
}

function taskSummary(source: string): { text: string; from: number } {
  const frontmatter = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(source);
  const bodyOffset = frontmatter === null ? 0 : frontmatter[0].length;
  const body = source.slice(bodyOffset);
  let lineOffset = 0;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) {
      const from = bodyOffset + lineOffset + line.indexOf(trimmed);
      return {
        text: trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed,
        from,
      };
    }
    lineOffset += line.length + 1;
  }
  return { text: "", from: bodyOffset };
}

/** Optimistic change-status transition for a local write: a path the board
 * has never seen is an ADD; a known one keeps its status (added stays
 * added) or becomes modified. */
export function changeAfterWrite(
  current: TaskChangeStatus | undefined,
  known: boolean,
): TaskChangeStatus {
  if (current !== undefined) return current;
  return known ? "modified" : "added";
}

/** Optimistic transition for a local delete: deleting an uncommitted ADD
 * erases the change entirely (nothing existed at base); anything else is a
 * deletion. Returns null to clear the entry. */
export function changeAfterDelete(
  current: TaskChangeStatus | undefined,
): TaskChangeStatus | null {
  return current === "added" ? null : "deleted";
}
