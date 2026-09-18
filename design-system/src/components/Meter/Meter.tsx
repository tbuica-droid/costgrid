import * as React from "react";
import { cx } from "../../utils/cx";
import "./Meter.css";

export interface MeterProps extends React.HTMLAttributes<HTMLDivElement> {
  label: React.ReactNode;
  /** 0 to 1. Values above 1 are drawn full and marked over. */
  fraction: number;
  /** Pre-formatted, e.g. "$412 of $500". */
  detail?: React.ReactNode;
}

/**
 * A budget against its ceiling.
 *
 * Fills in ink until it passes the limit, then turns the signal colour. The
 * bar does not shade gradually from green to red on the way up: a budget at
 * 70% is not a warning, it is a budget at 70%, and colouring it teaches people
 * to ignore the colour when it finally matters.
 *
 * @example
 * <Meter label="Support" fraction={0.82} detail="$412 of $500" />
 */
export function Meter({ label, fraction, detail, className, ...rest }: MeterProps) {
  const over = fraction > 1;
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div className={cx("cg-root", "cg-meter", className)} {...rest}>
      <div className="cg-meter__head">
        <span className="cg-meter__label">{label}</span>
        {detail ? <span className="cg-meter__detail cg-num">{detail}</span> : null}
      </div>
      <div
        className="cg-meter__track"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={typeof label === "string" ? label : undefined}
      >
        <div className={cx("cg-meter__fill", over && "cg-meter__fill--over")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
