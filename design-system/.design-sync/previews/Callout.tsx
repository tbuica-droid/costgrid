import * as React from "react";
import { Callout } from "@costgrid/ui";

export const Caveat = () => (
  <Callout>
    Prices the same token counts on the cheaper model. Token counts are not
    identical across models, so treat this as an estimate rather than a
    measurement.
  </Callout>
);

export const Warning = () => (
  <Callout tone="warning" title="This is spend avoided, not money saved">
    Each of these calls would have been refused, and the software that made it
    would have done something else, most likely retried.
  </Callout>
);
