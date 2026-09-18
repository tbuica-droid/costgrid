import * as React from "react";
import { cx } from "../../utils/cx";
import "./SectionHeader.css";

// `title` is omitted from the DOM attributes: HTML's own title is a tooltip
// string, and this one is a heading that may be rich content.
export interface SectionHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  /** A short category label. Two or three words, not a sentence. */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  /** One or two sentences. If it needs three, the section is doing too much. */
  lede?: React.ReactNode;
  as?: "h1" | "h2" | "h3";
  align?: "left" | "center";
}

/**
 * The top of a section.
 *
 * The eyebrow is a plain label rather than a numbered rail in a fixed column.
 * A "01 —" rail down the left of every section reserves a sixth of the
 * viewport to say something the heading already says.
 *
 * @example
 * <SectionHeader eyebrow="How it works" title="Three small changes, none of them to your own code." />
 */
export function SectionHeader({
  eyebrow, title, lede, as = "h2", align = "left", className, ...rest
}: SectionHeaderProps) {
  const Heading = as;
  return (
    <header className={cx("cg-root", "cg-secthead", `cg-secthead--${align}`, className)} {...rest}>
      {eyebrow ? <div className="cg-secthead__eyebrow">{eyebrow}</div> : null}
      <Heading className={cx("cg-secthead__title", as === "h1" && "cg-secthead__title--hero")}>
        {title}
      </Heading>
      {lede ? <p className="cg-secthead__lede">{lede}</p> : null}
    </header>
  );
}
