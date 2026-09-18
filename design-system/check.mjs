import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import * as UI from "./dist/index.js";

const names = Object.keys(UI).filter((k) => /^[A-Z]/.test(k));
console.log("exported components:", names.join(", "));

const samples = [
  React.createElement(UI.Button, null, "Start the free trial"),
  React.createElement(UI.Stat, { label: "Total spend", value: "$106.81", signal: "saved" }),
  React.createElement(UI.Delta, { value: "+$412.00" }),
  React.createElement(UI.Delta, { value: "-12%", badDirection: "down" }),
  React.createElement(UI.Badge, { tone: "over" }, "blocked"),
  React.createElement(UI.Callout, { tone: "warning", title: "Spend avoided" }, "not money saved"),
  React.createElement(UI.SectionHeader, { title: "Three small changes" }),
  React.createElement(UI.Panel, { variant: "inverse" }, "dark"),
  React.createElement(UI.Meter, { label: "Support", fraction: 1.14, detail: "$570 of $500" }),
  React.createElement(UI.CodeBlock, { label: "Setup" }, "client = Anthropic()"),
  React.createElement(UI.Field, { label: "Email", htmlFor: "e" },
    React.createElement("input", { id: "e", className: "cg-input" })),
  React.createElement(UI.DataTable, {
    columns: [
      { key: "t", header: "Team", render: (r) => r.t },
      { key: "s", header: "Spend", numeric: true, render: (r) => r.s },
    ],
    rows: [{ t: "Support", s: "$29.02" }],
    total: { label: "Total", values: { s: "$106.81" } },
  }),
];

let ok = 0;
for (const el of samples) {
  const html = renderToStaticMarkup(el);
  if (!html || html.length < 5) throw new Error("empty render: " + el.type?.name);
  ok++;
}
console.log(`rendered ${ok}/${samples.length} samples`);

// The colour rule, asserted rather than assumed.
const over = renderToStaticMarkup(React.createElement(UI.Delta, { value: "+$412.00" }));
const saved = renderToStaticMarkup(React.createElement(UI.Delta, { value: "-$96.40" }));
const flat = renderToStaticMarkup(React.createElement(UI.Delta, { value: "$0.00" }));
const down = renderToStaticMarkup(React.createElement(UI.Delta, { value: "-12%", badDirection: "down" }));
console.log("rising spend is over:", over.includes("cg-delta--over"));
console.log("falling spend is saved:", saved.includes("cg-delta--saved"));
console.log("no change is neutral:", !flat.includes("--over") && !flat.includes("--saved"));
console.log("falling success rate is over:", down.includes("cg-delta--over"));
