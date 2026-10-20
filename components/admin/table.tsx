import type { ReactNode } from "react";

/** A header label, or a label plus alignment for numeric columns. */
export type AdminColumn = string | { label: string; align?: "end" };

/**
 * Plain data table for the admin console. `columns` are header labels;
 * `children` are the `<tr>` rows the caller builds itself — this component
 * only owns the `<table>`/`<thead>` scaffold and the `.admin-table` styling
 * hook in `app/globals.css`.
 *
 * A column declared `{ align: "end" }` right-aligns its header; the caller
 * marks the matching cells with `className="admin-num"` so figures line up
 * on tabular numerals. `title` and `count` render an optional toolbar row
 * above the table, inside the same card.
 */
export function AdminTable({
  columns,
  children,
  title,
  count,
}: {
  columns: AdminColumn[];
  children: ReactNode;
  title?: ReactNode;
  count?: number;
}) {
  return (
    <div className="admin-table-wrap">
      {(title || count !== undefined) && (
        <div className="admin-table-toolbar">
          {title && <span className="admin-table-title">{title}</span>}
          {count !== undefined && <span className="admin-table-count">{count.toLocaleString()}</span>}
        </div>
      )}
      <div className="admin-table-scroll">
        <table className="admin-table">
          <thead>
            <tr>
              {columns.map((column) => {
                const { label, align } = typeof column === "string" ? { label: column, align: undefined } : column;
                return (
                  <th key={label} scope="col" className={align === "end" ? "admin-num" : undefined}>
                    {label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}
