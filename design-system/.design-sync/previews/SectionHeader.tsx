import * as React from "react";
import { SectionHeader } from "@costgrid/ui";

export const Hero = () => (
  <SectionHeader
    as="h1"
    eyebrow="Cost control for the AI inside your software"
    title="Per-token prices are collapsing. Your AI bill is going up anyway."
    lede="Your software calls AI, and the bill arrives a month later with no way to tell who spent what."
  />
);

export const Section = () => (
  <SectionHeader
    eyebrow="How it works"
    title="Three small changes, none of them to your own code."
  />
);
