import { useCallback, useEffect, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "../ui/sheet.tsx";
import { Button } from "../ui/button.tsx";
import { Badge } from "../ui/badge.tsx";
import type { WorkspaceStreamEvent } from "../lib/tasks-api.ts";

/**
 * The workspace's platform stream, live: every durable fact (birth,
 * configuration, …) newest first, with payloads inspectable inline. Refreshes
 * while open on a light cadence.
 */
export function StreamEventsSheet({
  open,
  loadEvents,
  onClose,
}: {
  open: boolean;
  loadEvents: () => Promise<WorkspaceStreamEvent[]>;
  onClose: () => void;
}) {
  const [events, setEvents] = useState<WorkspaceStreamEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void loadEvents()
      .then((next) => {
        setEvents(next);
        setError(null);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [loadEvents]);

  useEffect(() => {
    if (!open) return;
    setEvents(null);
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <SheetTitle className="text-base">Stream events</SheetTitle>
          <span className="text-xs text-muted-foreground">the workspace's event-sourced spine</span>
          <Button variant="ghost" size="icon" className="ml-auto" onClick={refresh}>
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {error !== null && (
            <p className="border-b bg-destructive/10 px-4 py-2 text-xs text-red-700">{error}</p>
          )}
          {events === null ? (
            <p className="p-4 text-sm text-muted-foreground">Loading events…</p>
          ) : events.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No events yet.</p>
          ) : (
            events.map((event) => (
              <details key={event.offset} className="border-b px-4 py-2">
                <summary className="flex cursor-pointer items-center gap-2 text-sm">
                  <Badge variant="outline" className="font-mono text-[10px]">
                    #{event.offset}
                  </Badge>
                  <span className="truncate font-mono text-xs">
                    {event.type.replace("events.iterate.com/", "")}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {event.createdAt ? new Date(event.createdAt).toLocaleTimeString() : ""}
                  </span>
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-[11px] whitespace-pre-wrap">
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              </details>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
