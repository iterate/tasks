import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ListTodoIcon, PlusIcon } from "lucide-react";
import { newCheckoutId } from "../lib/checkout-shared.ts";
import { CheckoutBreadcrumbs } from "../components/checkout-header.tsx";
import { Button } from "../ui/button.tsx";
import { SidebarTrigger } from "../ui/sidebar.tsx";

export const Route = createFileRoute("/")({ component: Home });

/**
 * The empty state: the sidebar carries the real navigation (repo →
 * checkouts), so home just points at it and offers a fresh checkout of the
 * default repo.
 */
function Home() {
  const navigate = useNavigate();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-background px-3">
        <SidebarTrigger className="-ml-1" />
        <CheckoutBreadcrumbs />
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-muted/30 p-8 text-center">
        <ListTodoIcon aria-hidden className="size-8 text-muted-foreground/60" />
        <div>
          <p className="text-sm font-medium">Pick a checkout from the sidebar</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            A checkout is a shared working copy of a repo&rsquo;s tasks — everyone on its link
            edits together, live. Committing flushes the changes to git.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() =>
            void navigate({
              to: "/c/$checkoutId",
              params: { checkoutId: newCheckoutId() },
              search: {},
            })
          }
        >
          <PlusIcon aria-hidden className="size-3.5" />
          New checkout
        </Button>
      </div>
    </div>
  );
}
