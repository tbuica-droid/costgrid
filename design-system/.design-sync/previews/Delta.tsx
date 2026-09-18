import * as React from "react";
import { Delta } from "@costgrid/ui";

/** Spend rising is bad news, so "+" reads red. */
export const Spend = () => (
  <div style={{ display: "flex", gap: 24 }}>
    <Delta value="+$412.00" />
    <Delta value="-$96.40" />
    <Delta value="$0.00" />
  </div>
);

/** A success rate falling is bad news, so "-" reads red instead. */
export const SuccessRate = () => (
  <div style={{ display: "flex", gap: 24 }}>
    <Delta value="-12%" badDirection="down" />
    <Delta value="+4%" badDirection="down" />
  </div>
);
