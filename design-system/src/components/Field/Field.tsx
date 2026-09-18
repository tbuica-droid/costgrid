import * as React from "react";
import { cx } from "../../utils/cx";
import "./Field.css";

export interface FieldProps {
  label: string;
  /** Must match the control's id. */
  htmlFor: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

/**
 * A labelled form control.
 *
 * The 16px minimum on inputs is not a taste decision: iOS Safari zooms the
 * whole page when a focused input is smaller, which throws the layout sideways
 * mid-form. That rule lives in the stylesheet so no page can forget it.
 *
 * @example
 * <Field label="Work email" htmlFor="f_email">
 *   <input id="f_email" type="email" className="cg-input" required />
 * </Field>
 */
export function Field({ label, htmlFor, hint, children, className }: FieldProps) {
  return (
    <div className={cx("cg-root", "cg-field", className)}>
      <label className="cg-field__label" htmlFor={htmlFor}>{label}</label>
      {children}
      {hint ? <div className="cg-field__hint">{hint}</div> : null}
    </div>
  );
}
