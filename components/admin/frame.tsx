import type { ComponentProps, ReactNode } from "react";

/**
 * Shell for the admin console: `/admin/**`. Structurally the same shape as
 * `components/auth/frame.tsx` (eyebrow / title / lede / children / aside) —
 * that file's own header explains why this repo keeps that shape rather than
 * a generic page-header component: it is plain CSS, Server Component only,
 * and deliberately carries no framework.
 *
 * Unlike `AuthFrame`, this does not render the "MCP Gateway" wordmark
 * itself — `app/admin/layout.tsx` already renders that once, in the nav bar
 * that wraps every admin page, so repeating it here on every page would be
 * noise rather than orientation.
 */
export function AdminFrame({
  eyebrow,
  title,
  lede,
  children,
  aside,
}: {
  eyebrow: string;
  title: ReactNode;
  lede?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="admin-frame">
      <div className="admin-eyebrow">{eyebrow}</div>

      <header>
        <h1 className="admin-title">{title}</h1>
        {lede && <p className="admin-lede">{lede}</p>}
      </header>

      {children}

      {aside && <div className="admin-aside">{aside}</div>}
    </div>
  );
}

/** Card a form or table sits in. */
export function AdminPanel({ children }: { children: ReactNode }) {
  return <div className="admin-panel">{children}</div>;
}

/** Labeled input field, for the small forms admin pages post to Server Actions. */
export function AdminField({
  label,
  hint,
  ...props
}: ComponentProps<"input"> & { label: string; hint?: string }) {
  return (
    <label className="admin-field">
      <span className="admin-field-label-row">
        <span className="admin-field-label">{label}</span>
        {hint && <span className="admin-field-hint">{hint}</span>}
      </span>
      <input {...props} />
    </label>
  );
}

/** Full-width primary submit button. */
export function AdminSubmit({ children }: { children: ReactNode }) {
  return (
    <button type="submit" className="admin-submit">
      {children}
    </button>
  );
}

/** Status notice. Always a label plus optional detail, never a bare line of text. */
export function AdminNotice({
  tone = "info",
  label,
  children,
}: {
  tone?: "info" | "error" | "ok";
  label: string;
  children?: ReactNode;
}) {
  const className = tone === "error" ? "admin-notice admin-notice-error" : "admin-notice";
  return (
    <div className={className} data-tone={tone}>
      <div className="admin-notice-label">{label}</div>
      {children && <div className="admin-notice-body">{children}</div>}
    </div>
  );
}
