import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";
import { normalizeProjectRef } from "../state.ts";
import { useBoard } from "../lib/use-board.ts";
import { useMe } from "../lib/use-me.ts";
import { Kanban } from "../components/kanban.tsx";

export const Route = createFileRoute("/p/$project")({ component: BoardRoute });

function BoardRoute() {
  // A hand-typed URL ("/p/My-Project") normalizes to the same board the home
  // form would open; only a ref with nothing salvageable dead-ends.
  const project = normalizeProjectRef(Route.useParams().project);
  if (!project) {
    return (
      <div>
        <p>Not a usable project reference.</p>
        <p>
          <Link to="/">← home</Link>
        </p>
      </div>
    );
  }
  return <BoardGate project={project} />;
}

function BoardGate({ project }: { project: string }) {
  const { me, loading } = useMe();
  if (loading) return <p style={{ color: "#9aa3ad" }}>checking session…</p>;
  if (me === null) {
    // Signed out: do not open the board socket at all — the worker would only
    // reject the upgrade. Send them through the login round trip instead.
    return (
      <Card>
        <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.1rem" }}>Sign in required</h2>
        <p style={{ color: "#9aa3ad", margin: "0 0 1rem" }}>
          Boards are only visible to signed-in iterate users.
        </p>
        <a
          href={`/auth/login?next=${encodeURIComponent(`/p/${project}`)}`}
          style={{
            display: "inline-block",
            border: "1px solid #2a2f36",
            borderRadius: "8px",
            padding: "0.4rem 0.9rem",
            background: "#22262c",
          }}
        >
          Sign in with Iterate
        </a>
      </Card>
    );
  }
  return <BoardPage project={project} />;
}

function BoardPage({ project }: { project: string }) {
  const { board, api, connectionError } = useBoard(project);

  if (board === undefined) {
    return (
      <div>
        <BoardHeading project={project} />
        {connectionError ? (
          <ErrorCard message={connectionError} />
        ) : (
          <p style={{ color: "#9aa3ad" }}>connecting…</p>
        )}
      </div>
    );
  }

  return (
    <div>
      <BoardHeading project={project} />
      {connectionError ? <ErrorCard message={connectionError} /> : null}
      {board.status === "unpaired" ? (
        <PairingCard project={project} />
      ) : board.status === "connecting" ? (
        <p style={{ color: "#9aa3ad" }}>connecting to the project repo…</p>
      ) : board.status === "error" ? (
        <ErrorCard message={board.error ?? "something went wrong"}>
          <button type="button" disabled={api === null} onClick={() => void api?.refresh()}>
            Retry
          </button>
        </ErrorCard>
      ) : (
        <>
          <Kanban board={board} api={api} />
          <p style={{ color: "#6b7280", fontSize: "0.8rem", marginTop: "1rem" }}>
            {board.commitOid ? <code>{board.commitOid.slice(0, 7)}</code> : "no commit"}
            {" · "}
            {board.tasks.length} task{board.tasks.length === 1 ? "" : "s"}
          </p>
        </>
      )}
    </div>
  );
}

function BoardHeading({ project }: { project: string }) {
  return (
    <h1 style={{ fontSize: "1.2rem", margin: "0 0 1rem" }}>
      <span style={{ color: "#6b7280", fontWeight: 400 }}>board / </span>
      {project}
    </h1>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        maxWidth: "28rem",
        background: "#22262c",
        border: "1px solid #2a2f36",
        borderRadius: "8px",
        padding: "1.25rem",
      }}
    >
      {children}
    </div>
  );
}

function ErrorCard({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div
      style={{
        maxWidth: "34rem",
        background: "#2a1b1d",
        border: "1px solid #4a2a2e",
        borderRadius: "8px",
        padding: "0.9rem 1.1rem",
        margin: "0 0 1rem",
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
      }}
    >
      <span style={{ color: "#e6b3b8", flex: 1 }}>{message}</span>
      {children}
    </div>
  );
}

function PairingCard({ project }: { project: string }) {
  const [projectId, setProjectId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pair = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/pair/${project}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, apiKey }),
      });
      if (!response.ok) setError(await response.text());
      // On 200 there is nothing else to do: the board's live state flips to
      // "connecting"/"ready" and this card unmounts on the pushed patch.
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.1rem" }}>Link this board</h2>
      <p style={{ color: "#9aa3ad", margin: "0 0 1rem" }}>
        This board isn&rsquo;t linked to an iterate project yet. Paste the project id and its API
        key to pair it.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (projectId.trim() && apiKey.trim()) void pair();
        }}
        style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}
      >
        <input
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
          placeholder="prj_…"
          aria-label="project id"
          disabled={busy}
        />
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="project API key"
          aria-label="project API key"
          disabled={busy}
        />
        <p style={{ color: "#6b7280", fontSize: "0.8rem", margin: 0 }}>
          Reveal it at os.iterate.com → your project → /secrets/project-api-key
        </p>
        {error ? <p style={{ color: "#e6b3b8", margin: 0 }}>{error}</p> : null}
        <div>
          <button type="submit" disabled={busy || !projectId.trim() || !apiKey.trim()}>
            {busy ? "pairing…" : "pair"}
          </button>
        </div>
      </form>
    </Card>
  );
}
