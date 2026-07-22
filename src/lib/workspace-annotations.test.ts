import { expect, it } from "vitest";
import { workspaceAnnotationSnapshot } from "./workspace-annotations.ts";

it("folds one task's durable review events into its current annotation snapshot", () => {
  const first = annotation({ id: "ann-1", text: "Please make this measurable." });
  const otherTask = annotation({ id: "ann-other", text: "Unrelated." });

  expect(
    workspaceAnnotationSnapshot(
      [
        event(1, "annotation-added", "tasks/launch.md", { annotation: first }),
        event(2, "annotation-added", "tasks/other.md", { annotation: otherTask }),
        event(3, "annotation-updated", "tasks/launch.md", {
          id: first.id,
          updates: { text: "Please add a concrete success metric." },
        }),
        event(4, "annotation-added", "tasks/launch.md", {
          annotation: annotation({ id: "ann-2", text: "Keep this paragraph." }),
        }),
        event(5, "annotation-removed", "tasks/launch.md", { id: first.id }),
      ],
      "tasks/launch.md",
    ),
  ).toMatchObject({
    annotations: [{ id: "ann-2", text: "Keep this paragraph." }],
    version: 5,
  });
});

function annotation(input: { id: string; text: string }) {
  return {
    ...input,
    author: "Ada",
    blockId: "block-1",
    createdA: 1,
    endOffset: 4,
    originalText: "ship",
    startOffset: 0,
    type: "COMMENT" as const,
  };
}

function event(
  offset: number,
  operation: "annotation-added" | "annotation-updated" | "annotation-removed",
  path: string,
  fields: Record<string, unknown>,
) {
  return {
    createdAt: `2026-07-22T10:00:0${offset}.000Z`,
    offset,
    payload: { path, ...fields },
    type: `events.iterate.com/tasks/plannotator/${operation}`,
  };
}
