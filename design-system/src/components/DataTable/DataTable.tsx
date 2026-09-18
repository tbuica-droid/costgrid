import * as React from "react";
import { cx } from "../../utils/cx";
import "./DataTable.css";

export interface Column<Row> {
  key: string;
  header: React.ReactNode;
  /** Numeric columns are right-aligned and set in tabular figures. */
  numeric?: boolean;
  render: (row: Row) => React.ReactNode;
}

export interface DataTableProps<Row> extends Omit<React.HTMLAttributes<HTMLTableElement>, "children"> {
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  /** A closing row, ruled off above like a sum in an account. */
  total?: { label: React.ReactNode; values: Record<string, React.ReactNode> };
  caption?: React.ReactNode;
}

/**
 * A table of figures, set the way an account is set.
 *
 * Numbers right-align on their last digit, rows are separated by the lightest
 * rule in the system, and a total is closed off by the heaviest. That rule
 * hierarchy is doing the work a box would otherwise do, which is why this
 * table needs no border around it.
 *
 * @example
 * <DataTable
 *   columns={[
 *     { key: "team", header: "Team", render: (r) => r.team },
 *     { key: "spend", header: "Spend", numeric: true, render: (r) => r.spend },
 *   ]}
 *   rows={[{ team: "Support", spend: "$29.02" }]}
 *   total={{ label: "Total", values: { spend: "$106.81" } }}
 * />
 */
export function DataTable<Row>({ columns, rows, total, caption, className, ...rest }: DataTableProps<Row>) {
  return (
    <div className="cg-root cg-table__scroll">
      <table className={cx("cg-table", className)} {...rest}>
        {caption ? <caption className="cg-table__caption">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cx(c.numeric && "cg-table__num")}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.key} className={cx(c.numeric && "cg-table__num", c.numeric && "cg-num")}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {total ? (
          <tfoot>
            <tr>
              {columns.map((c, i) => (
                <td key={c.key} className={cx(c.numeric && "cg-table__num", c.numeric && "cg-num")}>
                  {i === 0 ? total.label : (total.values[c.key] ?? null)}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
