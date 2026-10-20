"use client";

import { useState } from "react";

/**
 * A read-only value with a copy button.
 *
 * This is the FIRST and, so far, only client component in this repo, which
 * otherwise renders everything on the server (see `app/globals.css`'s header
 * and the phase 3 plan's global constraints). Copying to the clipboard has no
 * server-side equivalent — `navigator.clipboard` only exists in a browser —
 * and the value being copied here is a connection URL people would otherwise
 * retype by hand from documentation, which is how the wrong host and the
 * wrong path shape get into a customer's config.
 *
 * It is deliberately a leaf: it takes a string, touches no data, and reaches
 * no Supabase client. Nothing about the server-side authorization model moves
 * into the browser by its existence.
 *
 * The <input readonly> is what makes this work without JavaScript at all: if
 * the clipboard API is unavailable (an insecure origin, an old browser, a
 * denied permission), the value is still selectable and copyable by hand, and
 * the button reports honestly rather than silently doing nothing.
 */
export function CopyField({ label, value }: { label?: string; value: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2000);
  }

  return (
    <div className="copy-field">
      {label && <span className="copy-field-label">{label}</span>}
      <div className="copy-field-row">
        <input
          type="text"
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="copy-field-input"
          aria-label={label ?? "Value to copy"}
        />
        <button type="button" onClick={copy} className="copy-field-button">
          {state === "copied" ? "Copied" : state === "failed" ? "Select it" : "Copy"}
        </button>
      </div>
    </div>
  );
}
