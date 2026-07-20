import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useBoard } from "../lib/use-board.ts";
import { Kanban } from "../components/kanban.tsx";

export const Route = createFileRoute("/")({ component: BoardPage });

/**
 * The board IS the root route. The project is implicit in the reverse proxy
 * (`x-itx-project-id` + `iterate-project-auth` cookie); the client just dials
 * `/api/board`.
 */
function BoardPage() {
  const { board, api, connectionError } = useBoard();

  if (board === undefined) {
    return (
      <div>
        <BoardHeading projectId={null} />
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
      <BoardHeading projectId={board.projectId} />
      {connectionError ? <ErrorCard message={connectionError} /> : null}
      {board.status === "connecting" ? (
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

function BoardHeading({ projectId }: { projectId: string | null }) {
  return (
    <h1 style={{ fontSize: "1.2rem", margin: "0 0 1rem" }}>
      <span style={{ color: "#6b7280", fontWeight: 400 }}>board</span>
      {projectId ? (
        <>
          <span style={{ color: "#6b7280", fontWeight: 400 }}> / </span>
          {projectId}
        </>
      ) : null}
    </h1>
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
