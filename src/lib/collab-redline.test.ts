import { describe, expect, test } from "vitest";
import { decorate } from "./collab-redline.ts";

describe("decorate", () => {
  test("out-of-order segments must not crash the builder", () => {
    // Server order is position-sorted, but clamping (or any future source)
    // can reorder — RangeSetBuilder throws on descending ranges unless the
    // layer sorts defensively.
    const set = decorate(
      [
        { clientId: "b", from: 10, kind: "inserted", to: 14 },
        { at: 2, clientId: "a", kind: "deleted", text: "gone" },
        { clientId: "c", from: 2, kind: "inserted", to: 5 },
      ],
      20,
    );
    expect(set.size).toBe(3);
  });

  test("clamping past docLength keeps ascending order", () => {
    const set = decorate(
      [
        { clientId: "a", from: 8, kind: "inserted", to: 12 },
        { at: 30, clientId: "b", kind: "deleted", text: "tail" },
      ],
      10,
    );
    expect(set.size).toBe(2);
  });
});
