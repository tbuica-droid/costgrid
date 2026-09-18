import * as React from "react";
import { cx } from "../../utils/cx";
import "./Delta.css";

export interface DeltaProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Pre-formatted, including its sign: "+$412.00", "-18%". */
  value: string;
  /**
   * Which direction is bad. For spend, up is bad, which is the default. For a
   * saving or a success rate, set `"down"`.
   */
  badDirection?: "up" | "down";
}

/**
 * A signed change, coloured by what it means rather than by its sign.
 *
 * Spend rising is the product's bad news, so "+" is usually red. A success
 * rate falling is also bad news, and "-" is red there. Getting this backwards
 * is the single easiest way to make a cost dashboard lie at a glance, so the
 * direction is an explicit prop rather than inferred.
 *
 * @example
 * <Delta value="+$412.00" />
 * @example
 * <Delta value="-12%" badDirection="down" />
 */
export function Delta({ value, badDirection = "up", className, ...rest }: DeltaProps) {
  const rising = value.trim().startsWith("+");
  const isBad = badDirection === "up" ? rising : !rising;
  const flat = /^[+-]?[$0.,%\s]*0[.,0]*%?$/.test(value.trim());

  return (
    <span
      className={cx("cg-delta", "cg-num", !flat && (isBad ? "cg-delta--over" : "cg-delta--saved"), className)}
      {...rest}
    >
      {value}
    </span>
  );
}
