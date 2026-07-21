import type { ReactNode } from "react";
import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import appCss from "../styles.css?url";
import { SidebarInset, SidebarProvider } from "../ui/sidebar.tsx";
import { AppSidebar } from "../components/app-sidebar.tsx";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Iterate Tasks" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

/**
 * The whole app is a sidebar (repos → checkouts, from the project's index
 * DO) plus whatever page is open — deliberately no header; each page owns
 * its own top strip (the board's filter bar).
 */
function RootComponent() {
  return (
    <RootDocument>
      <SidebarProvider className="h-svh">
        <AppSidebar />
        <SidebarInset className="min-w-0 overflow-hidden">
          <Outlet />
        </SidebarInset>
      </SidebarProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
