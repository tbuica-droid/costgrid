import * as React from "react";
import { cx } from "../../utils/cx";
import "./CodeBlock.css";

export interface CodeBlockProps extends React.HTMLAttributes<HTMLPreElement> {
  /** A short caption above, e.g. "Point your client at CostGrid". */
  label?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Code a reader is meant to copy.
 *
 * This is the only place mono type belongs on a marketing page. Using it for
 * nav, buttons and captions signals "technical" without earning it, and is the
 * fastest way to make a site look machine-made.
 *
 * @example
 * <CodeBlock label="One line of setup">
 *   {`client = Anthropic(base_url="https://costgrid.acme.dev")`}
 * </CodeBlock>
 */
export function CodeBlock({ label, children, className, ...rest }: CodeBlockProps) {
  return (
    <div className="cg-root cg-code">
      {label ? <div className="cg-code__label">{label}</div> : null}
      <pre className={cx("cg-code__pre", className)} {...rest}><code>{children}</code></pre>
    </div>
  );
}
