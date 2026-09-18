import * as React from "react";
import { Meter } from "@costgrid/ui";

export const Budgets = () => (
  <div style={{ display: "grid", gap: 20, maxWidth: 420 }}>
    <Meter label="Support" fraction={0.34} detail="$170 of $500" />
    <Meter label="Research" fraction={0.82} detail="$412 of $500" />
    <Meter label="Engineering" fraction={1.14} detail="$570 of $500" />
  </div>
);
