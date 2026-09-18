import * as React from "react";
import { cx } from "../../utils/cx";
import "./Panel.css";

export interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * `plain` has no border at all and is the right default. Reach for `ruled`
   * only when two things genuinely need separating and space cannot do it.
   */
  variant?: "plain" | "ruled" | "sunk" | "inverse";
  padding?: "none" | "sm" | "md" | "lg";
}

/**
 * A surface.
 *
 * Deliberately unexciting, and deliberately bordered only on request. Putting
 * a hairline box around every group is what flattens a page into a grid where
 * nothing is more important than anything else.
 *
 * @example
 * <Panel>Most content needs no box at all.</Panel>
 * @example
 * <Panel variant="inverse" padding="lg">A dark closing section.</Panel>
 */
export function Panel({ variant = "plain", padding = "md", className, ...rest }: PanelProps) {
  return (
    <div
      className={cx("cg-root", "cg-panel", `cg-panel--${variant}`, `cg-panel--pad-${padding}`, className)}
      {...rest}
    />
  );
}
