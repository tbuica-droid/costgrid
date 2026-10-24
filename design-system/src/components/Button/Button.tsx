import * as React from "react";
import { cx } from "../../utils/cx";
import "./Button.css";

export type ButtonVariant = "primary" | "secondary" | "quiet";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** `primary` is the champagne accent pill. Use one per view. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

/**
 * An action, as a fully rounded pill. Primary is the accent; secondary is an
 * outline; quiet is text.
 *
 * Note there is no destructive variant. State colour in this system means
 * on track, needs a look or failing, and a button is not a state.
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
