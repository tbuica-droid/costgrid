import * as React from "react";
import { cx } from "../../utils/cx";
import "./Stat.css";

export interface StatProps extends React.HTMLAttributes<HTMLDivElement> {
  /** What the number is. Kept above it, small, so the figure leads. */
  label: string;
  /** The figure itself. Pre-formatted: this component never does maths. */
  value: React.ReactNode;
  /** One line of context under the figure. Say why it matters, not what it is. */
  note?: React.ReactNode;
  size?: "md" | "lg";
  /**
   * Only set this when the number *is* the good or bad news. A stat is not
   * decorated by colour; it is coloured when its direction is the point.
   */
  signal?: "over" | "saved";
}

/**
 * A single figure with its label. The workhorse of both the marketing page and
 * the dashboard, which is why it carries the tabular-figure settings itself.
 *
 * @example
 * <Stat label="Total spend" value="$106.81" note="30 days before: $0.00" />
 * @example
 * <Stat label="Saved by routing" value="$23.22" signal="saved" size="lg" />
 */
export function Stat({ label, value, note, size = "md", signal, className, ...rest }: StatProps) {
  return (
    <div className={cx("cg-root", "cg-stat", `cg-stat--${size}`, className)} {...rest}>
      <div className="cg-stat__label">{label}</div>
      <div className={cx("cg-stat__value", "cg-num", signal && `cg-stat__value--${signal}`)}>
        {value}
      </div>
      {note ? <div className="cg-stat__note">{note}</div> : null}
    </div>
  );
}
