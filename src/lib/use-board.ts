import { newWebSocketRpcSession } from "capnweb";
import { createLiveStateStore } from "iterate/live-state";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BoardApi, BoardState } from "../state.ts";

/**
 * The whole client: one Cap'n Web WebSocket to the board's Durable Object,
 * its live state folded into `createLiveStateStore` (snapshot + patches, the
 * same store `useLiveState` renders inside the iterate keeper) and read with
 * `useSyncExternalStore`. Mutations are plain calls on the session — the
 * server refreshes the one LiveState and every connected browser, this one
 * included, repaints from the pushed patch.
 */
export function useBoard(project: string) {
  const [api, setApi] = useState<BoardApi | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const storeRef = useRef(createLiveStateStore<BoardState>());
  const store = storeRef.current;

  useEffect(() => {
    store.reset();
    setApi(null);
    setConnectionError(null);
    const endpoint = new URL(`/api/board/${project}`, window.location.href);
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    // Hand-construct the socket (instead of passing the URL string) so we can
    // watch close/error ourselves: a rejected upgrade (401 from the worker)
    // surfaces as an immediate error+close the RPC session would otherwise
    // swallow into a hung "connecting…".
    const socket = new WebSocket(endpoint.toString());
    const session = newWebSocketRpcSession<BoardApi>(socket);

    let disposed = false;
    const onSocketDown = (event: Event) => {
      if (disposed) return;
      const reason = event instanceof CloseEvent && event.reason ? event.reason : null;
      setConnectionError(reason ?? "connection rejected — are you signed in?");
    };
    socket.addEventListener("close", onSocketDown);
    socket.addEventListener("error", onSocketDown);

    let subscription: { unsubscribe(): void } | undefined;
    const subscribe = async () => {
      // A revision gap in the store means a missed patch; resubscribing makes
      // the server lead with a fresh snapshot, which the store folds in. The
      // disposed guard is load-bearing: the store outlives this effect (one
      // ref across project changes), so a straggler update from this session's
      // dying WebSocket must not repopulate it after the next effect reset it
      // for another board.
      subscription?.unsubscribe();
      subscription = await session.liveState.subscribe((update) => {
        if (disposed) return;
        store.apply(update, () => {
          if (!disposed) void subscribe();
        });
      });
    };
    void subscribe()
      .then(() => {
        // Updater form is LOAD-BEARING: a Cap'n Web stub is a callable Proxy
        // (that is what makes pipelining work), so setApi(session) would make
        // React treat it as an updater and CALL it — storing a bogus
        // pipelined-call stub instead of the session.
        if (!disposed) setApi(() => session);
      })
      .catch(() => {
        // Strict-mode double-mount disposes the first session while its
        // subscribe is still in flight; the rejection is that disposal, not
        // a failure of the surviving session.
      });

    return () => {
      disposed = true;
      socket.removeEventListener("close", onSocketDown);
      socket.removeEventListener("error", onSocketDown);
      subscription?.unsubscribe();
      session[Symbol.dispose]();
    };
  }, [project, store]);

  const state = useSyncExternalStore(store.subscribe, store.getState, () => undefined);
  return { board: state, api, connectionError };
}
