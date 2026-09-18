import * as React from "react";
import { Stat } from "@costgrid/ui";

export const Single = () => (
  <Stat label="Total spend" value="$106.81" note="The 30 days before that: $0.00" />
);

/** Colour appears only because the direction is the point. */
export const Signals = () => (
  <div style={{ display: "flex", gap: 48, flexWrap: "wrap" }}>
    <Stat label="Saved by routing" value="$23.22" signal="saved" />
    <Stat label="Over budget" value="$412.00" signal="over" />
    <Stat label="Calls" value="2,056" />
  </div>
);

export const Large = () => (
  <Stat size="lg" label="Cost per result that worked" value="$0.22" note="Across 412 of 900 runs" />
);
