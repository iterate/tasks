import type { ReactNode } from "react";
import { createRootRoute, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Iterate Tasks" },
    ],
  }),
  component: RootComponent,
});

const baseStyles = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #0b0d10;
    color: #e6e8eb;
    font-family: system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.5;
  }
  a { color: #e6e8eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  button {
    font: inherit;
    color: #e6e8eb;
    background: #22262c;
    border: 1px solid #2a2f36;
    border-radius: 8px;
    padding: 0.35rem 0.75rem;
    cursor: pointer;
  }
  button:hover:not(:disabled) { background: #2a2f36; }
  button:disabled { opacity: 0.5; cursor: default; }
  input, textarea {
    font: inherit;
    color: #e6e8eb;
    background: #0b0d10;
    border: 1px solid #2a2f36;
    border-radius: 8px;
    padding: 0.35rem 0.6rem;
  }
  input:focus, textarea:focus { outline: 1px solid #4a5460; outline-offset: 0; }
  ::placeholder { color: #6b7280; }
`;

function RootComponent() {
  return (
    <RootDocument>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0.6rem 1.25rem",
          borderBottom: "1px solid #2a2f36",
          background: "#0e1114",
        }}
      >
        <Link to="/" style={{ fontWeight: 600, letterSpacing: "0.01em" }}>
          Iterate Tasks
        </Link>
      </header>
      <main style={{ padding: "1.25rem", maxWidth: "80rem", margin: "0 auto" }}>
        <Outlet />
      </main>
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
        <style>{baseStyles}</style>
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
