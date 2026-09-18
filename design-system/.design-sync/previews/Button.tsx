import * as React from "react";
import { Button } from "@costgrid/ui";

export const Primary = () => <Button>Start the free trial</Button>;

export const Variants = () => (
  <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
    <Button variant="primary">Start the free trial</Button>
    <Button variant="secondary">See the dashboard</Button>
    <Button variant="quiet">Read the docs</Button>
  </div>
);

export const Sizes = () => (
  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
    <Button size="sm">Small</Button>
    <Button size="md">Medium</Button>
    <Button size="lg">Large</Button>
  </div>
);
