import type { TaskCard } from "../state.ts";
import { parseTaskCard } from "../tasks-model.ts";

/** A card plus what the board needs to place and preview it. */
export type BoardTask = TaskCard & {
  /** Grouping key: "/" for files directly under tasks/, else "/sub/dir". */
  folder: string;
  /** First body line after the heading, for the card's excerpt. */
  summary: string;
};

export type PresenceUser = { name: string; color: string };

export function toBoardTask(path: string, source: string): BoardTask {
  const card = parseTaskCard(path, source);
  return { ...card, folder: taskFolder(path), summary: taskSummary(source) };
}

/** The path segments between the `tasks` directory and the filename. */
export function taskFolder(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const tasksIndex = segments.lastIndexOf("tasks");
  const between = segments.slice(tasksIndex + 1, -1);
  return between.length === 0 ? "/" : `/${between.join("/")}`;
}

/** Rebuild a task's path for a (possibly different) folder, keeping the filename. */
export function taskPathInFolder(path: string, folder: string): string {
  const segments = path.split("/").filter(Boolean);
  const tasksIndex = segments.lastIndexOf("tasks");
  const prefix = segments.slice(0, tasksIndex + 1).join("/");
  const filename = segments.at(-1)!;
  return folder === "/" ? `${prefix}/${filename}` : `${prefix}${folder}/${filename}`;
}

function taskSummary(source: string): string {
  const body = source.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, "");
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    return trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed;
  }
  return "";
}
