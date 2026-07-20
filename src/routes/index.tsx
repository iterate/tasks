import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { newCheckoutId } from "../lib/checkout-shared.ts";

export const Route = createFileRoute("/")({ component: NewCheckout });

/**
 * Landing on `/` starts a fresh collaborative checkout and redirects to its
 * shareable URL — everyone who opens that link edits the same in-DO working
 * copy of the project's task files.
 */
function NewCheckout() {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({
      to: "/c/$checkoutId",
      params: { checkoutId: newCheckoutId() },
      replace: true,
    });
  }, [navigate]);
  return <p style={{ color: "#9aa3ad" }}>starting a checkout…</p>;
}
