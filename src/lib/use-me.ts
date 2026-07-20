import { useEffect, useState } from "react";

export type Me = { email: string; name?: string };

/**
 * Who is signed in, per the worker's `/api/me`: 200 with
 * `{ user: { email, name? } }` for a live session, 401 when signed out.
 * `me` stays null while signed out; `loading` covers the first round trip.
 */
export function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    void fetch("/api/me")
      .then(async (response) => {
        if (!response.ok) return null;
        const body = (await response.json()) as { user?: Me };
        return body.user ?? null;
      })
      .catch(() => null)
      .then((user) => {
        if (disposed) return;
        setMe(user);
        setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, []);

  return { me, loading };
}
