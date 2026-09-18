import * as React from "react";
import { cx } from "../../utils/cx";
import "./Button.css";

export type ButtonVariant = "primary" | "secondary" | "quiet";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** `primary` is the solid ink block. Use one per view. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

/**
 * An action. Squared off rather than pill shaped, because this product reads
 * as an instrument rather than a consumer app.
 *
 * Note there is no destructive variant. Signal colour in this system means
 * "money moved the wrong way", and a button is not a fact about money.
 *
 * @example
 * <Button>Start the free trial</Button>
 * @example
 * <Button variant="secondary" size="lg">See the dashboard</Button>
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", fullWidth, className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        "cg-root",
        "cg-btn",
        `cg-btn--${variant}`,
        `cg-btn--${size}`,
        fullWidth && "cg-btn--block",
        className,
      )}
      {...rest}
    />
  );
});
