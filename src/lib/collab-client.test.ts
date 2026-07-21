import { describe, expect, test } from "vitest";
import { Text } from "@codemirror/state";
import { CollabConnection, commonSplice } from "./collab-client.ts";

describe("commonSplice", () => {
  test("identical → null", () => {
    expect(commonSplice("abc", "abc")).toBeNull();
  });
  test("insertion", () => {
    expect(commonSplice("hello world", "hello brave world")).toEqual({
      from: 6,
      insert: "brave ",
      to: 6,
    });
  });
  test("deletion", () => {
    expect(commonSplice("hello brave world", "hello world")).toEqual({
      from: 6,
      insert: "",
      to: 12,
    });
  });
  test("replacement keeps common prefix and suffix", () => {
    expect(commonSplice("aaa MIDDLE zzz", "aaa CENTER zzz")).toEqual({
      from: 4,
      insert: "CENTER",
      to: 10,
    });
  });
  test("repeated characters do not over-trim (prefix wins ties)", () => {
    const splice = commonSplice("aaa", "aaaa")!;
    const applied = "aaa".slice(0, splice.from) + splice.insert + "aaa".slice(splice.to);
    expect(applied).toBe("aaaa");
  });
});

describe("CollabConnection.carryOnto", () => {
  const connection = (synced: string) => {
    const instance = new CollabConnection("c1", "/repos/config", "/tasks/x.md");
    instance.synced = Text.of(synced.split("\n"));
    return instance;
  };

  test("no local divergence → snapshot verbatim", () => {
    expect(connection("base").carryOnto("newer snapshot", "base")).toBe("newer snapshot");
  });

  test("clean region → local edit re-applied exactly", () => {
    // Local typed " [me]" at the end; the snapshot changed only the start.
    const carried = connection("alpha beta").carryOnto("ALPHA beta", "alpha beta [me]");
    expect(carried).toBe("ALPHA beta [me]");
  });

  test("drifted region → insert-only, never deleting others' text", () => {
    // Local replaced "beta"→"BETA", but the snapshot rewrote that region too:
    // the local insert lands without destroying the snapshot's version.
    const carried = connection("alpha beta").carryOnto("alpha gamma", "alpha BETA");
    expect(carried).toContain("gamma"); // others' text preserved
    expect(carried).toContain("BETA"); // local text never silently discarded
  });

  test("reseed resets the confirmed baseline AND mints a fresh client identity", () => {
    const instance = connection("old");
    instance.confirmed = 7;
    const before = instance.clientId;
    instance.reseed({ content: "fresh", epoch: "e2", version: 42 });
    expect(instance.epoch).toBe("e2");
    expect(instance.confirmed).toBe(0);
    expect(instance.synced.toString()).toBe("fresh");
    // Same-epoch history-miss recovery restarts clientSeq at 0; reusing the
    // old clientId would collide with server-acked (clientId, seq) pairs and
    // every carried edit would be silently deduped away.
    expect(instance.clientId).not.toBe(before);
  });
});
