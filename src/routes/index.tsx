import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { normalizeProjectRef } from "../state.ts";
import { useMe } from "../lib/use-me.ts";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const navigate = useNavigate();
  const { me, loading } = useMe();
  const [ref, setRef] = useState("");
  const go = (target: string) => {
    const normalized = normalizeProjectRef(target);
    if (normalized) void navigate({ to: "/p/$project", params: { project: normalized } });
  };
  return (
    <div style={{ maxWidth: "36rem", margin: "3rem auto" }}>
      <h1 style={{ fontSize: "1.4rem", margin: "0 0 0.5rem" }}>Iterate Tasks</h1>
      <p style={{ color: "#9aa3ad", margin: "0 0 1.5rem" }}>
        A Kanban board over the tasks/ folder of your iterate project&rsquo;s config repo.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          go(ref);
        }}
        style={{ display: "flex", gap: "0.5rem" }}
      >
        <input
          value={ref}
          onChange={(event) => setRef(event.target.value)}
          placeholder="project id or slug"
          aria-label="project id or slug"
          style={{ flex: 1 }}
        />
        <button type="submit">open board</button>
      </form>
      {!loading && me === null ? (
        <p style={{ color: "#9aa3ad", marginTop: "1.5rem" }}>
          You&rsquo;ll need to{" "}
          <a href={`/auth/login?next=${encodeURIComponent("/")}`} style={{ color: "#e6e8eb" }}>
            sign in with Iterate
          </a>{" "}
          before a board will open.
        </p>
      ) : null}
    </div>
  );
}
