import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { DEFAULT_REPO_PATH, isCheckoutId, newCheckoutId } from "../lib/checkout-shared.ts";
import { listRepos } from "../lib/use-checkout.ts";

export const Route = createFileRoute("/")({ component: CheckoutPicker });

/**
 * The landing page: pick which repo to check out (loaded from the project's
 * repo catalog, defaulting to /repos/config) and optionally a checkout id —
 * empty means a fresh generated one. Go lands on the shareable
 * /c/<id>?repoPath=... URL; everyone who opens that link edits the same
 * in-DO working copy of that repo's task files.
 */
function CheckoutPicker() {
  const navigate = useNavigate();
  const [repos, setRepos] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [repoPath, setRepoPath] = useState(DEFAULT_REPO_PATH);
  const [checkoutId, setCheckoutId] = useState("");

  useEffect(() => {
    let cancelled = false;
    listRepos()
      .then((listed) => {
        if (cancelled) return;
        setRepos(listed);
        if (listed.length > 0 && !listed.includes(DEFAULT_REPO_PATH)) setRepoPath(listed[0]!);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setRepos([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmedId = checkoutId.trim();
  const idInvalid = trimmedId !== "" && !isCheckoutId(trimmedId);

  const go = () => {
    if (idInvalid) return;
    void navigate({
      to: "/c/$checkoutId",
      params: { checkoutId: trimmedId === "" ? newCheckoutId() : trimmedId },
      search: repoPath === DEFAULT_REPO_PATH ? {} : { repoPath },
    });
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        go();
      }}
      style={{
        maxWidth: "26rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
      }}
    >
      <h1 style={{ fontSize: "1.2rem", margin: 0 }}>Start a checkout</h1>
      <p style={{ color: "#9aa3ad", margin: 0 }}>
        A checkout is a shared working copy of a repo&rsquo;s <code>tasks/</code> markdown —
        everyone on its link edits together, live. Committing flushes the changes to git.
      </p>
      {loadError ? (
        <p style={{ color: "#e6b3b8", margin: 0 }}>could not load repos: {loadError}</p>
      ) : null}
      <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ color: "#9aa3ad", fontSize: "0.8rem" }}>Repo</span>
        {repos === null ? (
          <span style={{ color: "#6b7280" }}>loading repos…</span>
        ) : (
          <select
            value={repoPath}
            onChange={(event) => setRepoPath(event.target.value)}
            style={{
              font: "inherit",
              color: "#e6e8eb",
              background: "#0b0d10",
              border: "1px solid #2a2f36",
              borderRadius: "8px",
              padding: "0.35rem 0.6rem",
            }}
          >
            {(repos.length > 0 ? repos : [DEFAULT_REPO_PATH]).map((path) => (
              <option key={path} value={path}>
                {path}
              </option>
            ))}
          </select>
        )}
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={{ color: "#9aa3ad", fontSize: "0.8rem" }}>
          Checkout id <span style={{ color: "#6b7280" }}>(optional — empty generates one)</span>
        </span>
        <input
          value={checkoutId}
          onChange={(event) => setCheckoutId(event.target.value)}
          placeholder={newCheckoutIdPlaceholder}
          spellCheck={false}
        />
        {idInvalid ? (
          <span style={{ color: "#e6b3b8", fontSize: "0.8rem" }}>
            letters, digits, dashes, underscores only
          </span>
        ) : null}
      </label>
      <button type="submit" disabled={repos === null || idInvalid} style={{ alignSelf: "flex-start" }}>
        Open checkout
      </button>
    </form>
  );
}

const newCheckoutIdPlaceholder = "e.g. 20260720-2359-ab12";
