import * as React from "react";
import { cx } from "../../utils/cx";
import "./Badge.css";

export type BadgeTone = "neutral" | "over" | "saved";

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

/**
 * A small status marker: a policy's mode, a call's outcome, a channel name.
 *
 * `neutral` covers most of it, including "monitor", because a rule that is
 * only watching has not done anything worth colouring.
 *
 * @example
 * <Badge>monitor</Badge>
 * @example
 * <Badge tone="over">blocked</Badge>
 */
export function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  return <span className={cx("cg-badge", `cg-badge--${tone}`, className)} {...rest} />;
}
