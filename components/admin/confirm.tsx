import type { ReactNode } from "react";

/**
 * Submit button for a destructive Server Action. There is no client-side
 * `confirm()` anywhere in this repo — every admin page is a Server
 * Component, so the only mechanism available for "are you sure" is a label
 * that states the actual consequence up front, e.g. "Remove Dana and revoke
 * 2 keys" rather than a bare "Remove". The caller composes that sentence;
 * this component only supplies the consistent, visually-distinct styling
 * for "this button does something destructive."
 *
 * Inside a table row, where the row itself names the target, the caller may
 * keep the visible label short ("Remove") and put the full sentence in
 * `title`, which becomes the tooltip and the accessible name.
 */
export function ConfirmSubmit({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <button type="submit" className="admin-confirm-submit" title={title} aria-label={title}>
      {children}
    </button>
  );
}
