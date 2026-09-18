import * as React from "react";
import { Badge } from "@costgrid/ui";

export const Tones = () => (
  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
    <Badge>monitor</Badge>
    <Badge>claude-haiku-4-5</Badge>
    <Badge tone="over">blocked</Badge>
    <Badge tone="saved">routed</Badge>
  </div>
);
