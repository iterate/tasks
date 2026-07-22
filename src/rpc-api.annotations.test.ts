import { expect, it } from "vitest";
import { AnnotationType } from "@plannotator/ui/types";
import {
  WORKSPACE_ANNOTATION_EVENT_PREFIX,
  WorkspaceAnnotationJournal,
} from "./lib/workspace-annotations.ts";

it("stamps a new review annotation with the verified Iterate user", async () => {
  const recorded: unknown[] = [];
  const journal = new WorkspaceAnnotationJournal({
    append: async (...events) => {
      recorded.push(...events);
    },
    getEvents: async () => [],
    verifiedAuthor: "Ada",
  });

  const created = await journal.add(
    "/tasks/launch.md",
    annotation({ author: "Mallory" }),
  );

  expect(created).toMatchObject({ author: "Ada", id: "ann-1" });
  expect(recorded).toMatchObject([
    {
      payload: {
        annotation: { author: "Ada", id: "ann-1" },
        path: "tasks/launch.md",
      },
      type: `${WORKSPACE_ANNOTATION_EVENT_PREFIX}annotation-added`,
    },
  ]);
});

function annotation(input: { author: string }) {
  return {
    ...input,
    blockId: "block-1",
    createdA: 1,
    endOffset: 4,
    id: "ann-1",
    originalText: "ship",
    startOffset: 0,
    text: "Please make this measurable.",
    type: AnnotationType.COMMENT,
  };
}
