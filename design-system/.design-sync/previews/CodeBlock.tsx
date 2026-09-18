import * as React from "react";
import { CodeBlock } from "@costgrid/ui";

export const OneLine = () => (
  <CodeBlock label="Point your client at CostGrid">
{`client = Anthropic(
    base_url="https://costgrid.acme.dev",
    api_key="unused",
)`}
  </CodeBlock>
);
