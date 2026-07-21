import { useState } from "react";
import { CheckIcon, LinkIcon } from "lucide-react";
import type YProvider from "y-partyserver/provider";
import { localCollabUser, renameCollabUser } from "../lib/use-checkout.ts";
import type { TasksUser } from "../lib/tasks-api.ts";
import type { Peer } from "../lib/board-model.ts";
import { Button } from "../ui/button.tsx";

/**
 * You + everyone else in the checkout. Chips show the verified identity
 * when the platform provided one — hover for email, userId, and what the
 * person has open (the OS stream-processor presence vocabulary). Click your
 * own chip to override the display name.
 */
export function PresenceStrip({
  provider,
  peers,
  me,
}: {
  provider: YProvider;
  peers: Peer[];
  me: TasksUser | null;
}) {
  const [self, setSelf] = useState(() =>
    typeof window === "undefined" ? null : localCollabUser(),
  );
  if (self === null) return null;
  const selfName = me?.name ?? me?.email ?? self.name;
  const selfTitle = presenceTitle("You — click to rename", me?.email, me?.userId, null);
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        title={selfTitle}
        onClick={() => {
          const name = window.prompt("Your collaborator name", selfName);
          if (name?.trim()) setSelf(renameCollabUser(provider, name));
        }}
        className="rounded-full border bg-transparent px-2 py-0.5 text-[11px]"
        style={{ color: self.color, borderColor: `${self.color}66` }}
      >
        {selfName}
      </button>
      {peers.map((peer) => (
        <span
          key={peer.id}
          title={presenceTitle(peer.user.name, peer.email, peer.userId, peer.openPath)}
          className="rounded-full border px-2 py-0.5 text-[11px]"
          style={{ color: peer.user.color, borderColor: `${peer.user.color}66` }}
        >
          {peer.user.name}
        </span>
      ))}
    </span>
  );
}

export function ShareLink() {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 text-xs text-muted-foreground"
      title="Copy share link"
      onClick={() => {
        void navigator.clipboard.writeText(window.location.href).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? (
        <CheckIcon aria-hidden className="size-3.5" />
      ) : (
        <LinkIcon aria-hidden className="size-3.5" />
      )}
      {copied ? "Copied" : "Share"}
    </Button>
  );
}

function presenceTitle(
  name: string,
  email: string | null | undefined,
  userId: string | null | undefined,
  openPath: string | null,
): string {
  const lines = [name];
  if (email) lines.push(email);
  if (userId) lines.push(userId);
  if (openPath) lines.push(`editing ${openPath}`);
  return lines.join("\n");
}
