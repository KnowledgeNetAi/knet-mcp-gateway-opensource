import type { ComponentProps, ReactNode } from "react";
import Link from "next/link";

/**
 * Shell for the pages outside the MCP route handlers: sign in, forgot
 * password, confirm link, set password, and the OAuth consent screen.
 *
 * Deliberately unbranded beyond the "MCP Gateway" wordmark: a customer
 * signing in to their own gateway should not be looking at another
 * product's branding.
 * Plain CSS only (`app/globals.css`) — this repo has no Tailwind.
 */
export function AuthFrame({
  eyebrow,
  title,
  lede,
  children,
  aside,
}: {
  eyebrow: string;
  // ReactNode, not string: the OAuth consent screen (a later task) renders a
  // client's self-chosen, untrusted display name here and must be able to
  // wrap it in a clamping element rather than pass a plain string.
  title: ReactNode;
  lede?: ReactNode;
  children: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="auth-frame">
      <div className="auth-eyebrow">
        <span className="auth-wordmark">MCP Gateway</span>
        <span aria-hidden>/</span>
        <span>{eyebrow}</span>
      </div>

      <header>
        <h1 className="auth-title">{title}</h1>
        {lede && <p className="auth-lede">{lede}</p>}
      </header>

      {children}

      {aside && <div className="auth-aside">{aside}</div>}
    </div>
  );
}

/** Card the form sits in. */
export function AuthPanel({ children }: { children: ReactNode }) {
  return <div className="auth-panel">{children}</div>;
}

/** Labeled input field. */
export function AuthField({
  label,
  hint,
  ...props
}: ComponentProps<"input"> & { label: string; hint?: string }) {
  return (
    <label className="auth-field">
      <span className="auth-field-label-row">
        <span className="auth-field-label">{label}</span>
        {hint && <span className="auth-field-hint">{hint}</span>}
      </span>
      <input {...props} />
    </label>
  );
}

/** Full-width primary submit button. */
export function AuthSubmit({ children }: { children: ReactNode }) {
  return (
    <button type="submit" className="auth-submit">
      {children}
    </button>
  );
}

/** Status notice. Always a label plus optional detail, never a bare line of text. */
export function AuthNotice({
  tone = "info",
  label,
  children,
}: {
  tone?: "info" | "error" | "ok";
  label: string;
  children?: ReactNode;
}) {
  const className = tone === "error" ? "auth-notice auth-notice-error" : "auth-notice";
  return (
    <div className={className} data-tone={tone}>
      <div className="auth-notice-label">{label}</div>
      {children && <div className="auth-notice-body">{children}</div>}
    </div>
  );
}

/**
 * Quiet link used under the panel. Pass `external` for a destination off this
 * origin — an OAuth deny link goes straight to a client's registered
 * callback, which the client-side router has no business trying to handle.
 */
export function AuthLink({
  href,
  external,
  children,
}: {
  href: string;
  external?: boolean;
  children: ReactNode;
}) {
  if (external) {
    return (
      <a href={href} rel="noreferrer" className="auth-link">
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className="auth-link">
      {children}
    </Link>
  );
}
