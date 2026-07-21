import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ListFilterIcon, XIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../ui/breadcrumb.tsx";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";

/** The project slug, read off the `tasks--<slug>` app host. */
export function projectSlug(): string {
  if (typeof window === "undefined") return "project";
  const match = /^tasks--([^.]+)\./.exec(window.location.hostname);
  return match?.[1] ?? window.location.hostname;
}

/** project › repo › checkout — the top row's orientation line. */
export function CheckoutBreadcrumbs({
  repoPath,
  checkoutId,
}: {
  repoPath?: string;
  checkoutId?: string;
}) {
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap text-xs">
        <BreadcrumbItem>
          <BreadcrumbLink render={<Link to="/" />}>{projectSlug()}</BreadcrumbLink>
        </BreadcrumbItem>
        {repoPath === undefined ? null : (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="font-mono">{repoPath}</BreadcrumbItem>
          </>
        )}
        {checkoutId === undefined ? null : (
          <>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="truncate font-mono">{checkoutId}</BreadcrumbPage>
            </BreadcrumbItem>
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

/**
 * The Linear-style filter affordance: a quiet dropdown button that opens a
 * small panel with the query input; the button reads "Filtered" while a
 * query is active.
 */
export function FilterControl({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant={value !== "" ? "secondary" : "ghost"}
            size="sm"
            className="h-8 gap-1.5 text-xs"
          />
        }
      >
        <ListFilterIcon aria-hidden className="size-3.5" />
        <span className="hidden sm:inline">{value !== "" ? "Filtered" : "Filter"}</span>
        <ChevronDownIcon aria-hidden className="size-3" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <div className="relative">
          <Input
            autoFocus
            value={value}
            onChange={(event) => onChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                onChange("");
                setOpen(false);
              }
              if (event.key === "Enter") setOpen(false);
            }}
            placeholder="Filter tasks by title, text, label…"
            aria-label="Filter tasks"
            className="h-8 pr-7 text-sm"
          />
          {value === "" ? null : (
            <button
              type="button"
              aria-label="Clear filter"
              className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => onChange("")}
            >
              <XIcon aria-hidden className="size-3.5" />
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
