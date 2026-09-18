import * as React from "react";
import { Panel, Stat } from "@costgrid/ui";

export const Variants = () => (
  <div style={{ display: "grid", gap: 16 }}>
    <Panel>Plain is the default, and usually right. No border at all.</Panel>
    <Panel variant="ruled">Ruled, for when two surfaces genuinely differ.</Panel>
    <Panel variant="sunk">Sunk, for a quiet inset area.</Panel>
    <Panel variant="inverse" padding="lg">
      <Stat label="Enterprise AI spend, 2030" value="$207.3B" />
    </Panel>
  </div>
);
