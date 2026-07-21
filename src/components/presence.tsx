import { useState } from "react";
import type YProvider from "y-partyserver/provider";
import { localCollabUser, renameCollabUser } from "../lib/use-checkout.ts";
import type { TasksUser } from "../lib/tasks-api.ts";
import type { Peer } from "../lib/board-model.ts";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";

/**
 * Everyone in the checkout as overlapping avatars, the apps/os
 * stream-processor way: initials in the collaborator's color, hover reveals
 * name, email, userId, and what they have open. Your own avatar comes
 * first — click it to override the display name.
 */
export function PresenceAvatars({
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
  return (
    <span className="flex items-center -space-x-1.5">
      <PresenceAvatar
        name={selfName}
        color={self.color}
        image={me?.image ?? null}
        email={me?.email ?? null}
        userId={me?.userId ?? null}
        openPath={null}
        hint="You — click to rename"
        onClick={() => {
          const name = window.prompt("Your collaborator name", selfName);
          if (name?.trim()) setSelf(renameCollabUser(provider, name));
        }}
      />
      {peers.map((peer) => (
        <PresenceAvatar
          key={peer.id}
          name={peer.user.name}
          color={peer.user.color}
          image={peer.image ?? null}
          email={peer.email ?? null}
          userId={peer.userId ?? null}
          openPath={peer.openPath}
        />
      ))}
    </span>
  );
}

function PresenceAvatar({
  name,
  color,
  image,
  email,
  userId,
  openPath,
  hint,
  onClick,
}: {
  name: string;
  color: string;
  image: string | null;
  email: string | null;
  userId: string | null;
  openPath: string | null;
  hint?: string;
  onClick?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<button type="button" onClick={onClick} className="rounded-full" />}
      >
        <Avatar className="size-6 ring-2 ring-background">
          {image === null ? null : <AvatarImage src={image} alt={name} />}
          <AvatarFallback
            className="text-[10px] font-semibold"
            style={{ backgroundColor: `${color}26`, color }}
          >
            {initials(name)}
          </AvatarFallback>
        </Avatar>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex flex-col gap-0.5">
        <span className="font-medium">{name}</span>
        {email === null ? null : <span className="text-muted-foreground">{email}</span>}
        {userId === null ? null : (
          <span className="font-mono text-[10px] text-muted-foreground">{userId}</span>
        )}
        {openPath === null ? null : (
          <span className="text-muted-foreground">editing {openPath}</span>
        )}
        {hint === undefined ? null : <span className="text-muted-foreground">{hint}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return `${parts[0]?.[0] ?? "?"}${parts[1]?.[0] ?? ""}`.toUpperCase();
}

