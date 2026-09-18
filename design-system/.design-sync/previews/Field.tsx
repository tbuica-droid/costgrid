import * as React from "react";
import { Field, Button } from "@costgrid/ui";

export const TrialForm = () => (
  <form style={{ maxWidth: 420 }}>
    <Field label="Work email" htmlFor="f_email">
      <input id="f_email" type="email" className="cg-input" placeholder="you@company.com" />
    </Field>
    <Field label="Monthly AI spend" htmlFor="f_spend" hint="A rough figure is fine.">
      <select id="f_spend" className="cg-select" defaultValue="">
        <option value="">Prefer not to say</option>
        <option>Under $1k</option>
        <option>$1k to $5k</option>
      </select>
    </Field>
    <Button fullWidth>Request the trial</Button>
  </form>
);
