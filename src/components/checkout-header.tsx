import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ListFilterIcon, XIcon } from "lucide-react";
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
 * The Linear-style filter affordance: a quiet button that expands into the
 * filter input (which stays visible while a query is active).
 */
export function FilterControl({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const visible = open || value !== "";
  return (
    <span className="flex items-center gap-1.5">
      <Button
        variant={value !== "" ? "secondary" : "ghost"}
        size="sm"
        className="h-8 gap-1.5 text-xs"
        aria-expanded={visible}
        onClick={() => setOpen(!visible)}
      >
        <ListFilterIcon aria-hidden className="size-3.5" />
        <span className="hidden sm:inline">{value !== "" ? "Filtered" : "Filter"}</span>
      </Button>
      {visible ? (
        <span className="relative">
          <Input
            autoFocus={open}
            value={value}
            onChange={(event) => onChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                onChange("");
                setOpen(false);
              }
            }}
            placeholder="Filter tasks"
            aria-label="Filter tasks"
            className="h-8 w-48 pr-7 text-sm"
          />
          {value === "" ? null : (
            <button
              type="button"
              aria-label="Clear filter"
              className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              <XIcon aria-hidden className="size-3.5" />
            </button>
          )}
        </span>
      ) : null}
    </span>
  );
}
