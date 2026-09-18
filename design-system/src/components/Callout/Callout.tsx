import * as React from "react";
import { cx } from "../../utils/cx";
import "./Callout.css";

export interface CalloutProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /**
   * `caveat` is the default and by far the most used: the thing a figure rests
   * on, said out loud. `warning` is for something that costs money or is about
   * to.
   */
  tone?: "caveat" | "warning";
  title?: React.ReactNode;
}

/**
 * The honest note beside a number.
 *
 * CostGrid's whole position is that it says what a figure rests on: estimated
 * against measured, spend avoided against money saved, a rule that cannot fire.
 * This component exists so those notes have a consistent home instead of being
 * improvised as small grey text, which is how caveats end up invisible.
 *
 * Marked by a rule on the left rather than a filled box, so it sits beside the
 * content it qualifies instead of interrupting it.
 *
 * @example
 * <Callout>Prices the same token counts on the cheaper model, so treat this as
 * an estimate rather than a measurement.</Callout>
 * @example
 * <Callout tone="warning" title="This is spend avoided, not money saved">
 *   Each of these calls would have been refused.
 * </Callout>
 */
export function Callout({ tone = "caveat", title, children, className, ...rest }: CalloutProps) {
  return (
    <div className={cx("cg-root", "cg-callout", `cg-callout--${tone}`, className)} {...rest}>
      {title ? <div className="cg-callout__title">{title}</div> : null}
      <div className="cg-callout__body">{children}</div>
    </div>
  );
}
