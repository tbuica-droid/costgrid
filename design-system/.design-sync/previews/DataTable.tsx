import * as React from "react";
import { DataTable } from "@costgrid/ui";

type Row = { team: string; calls: string; spend: string };

const rows: Row[] = [
  { team: "Research", calls: "856", spend: "$77.43" },
  { team: "Support", calls: "900", spend: "$29.02" },
  { team: "Product", calls: "300", spend: "$0.36" },
];

export const SpendByTeam = () => (
  <DataTable<Row>
    columns={[
      { key: "team", header: "Team", render: (r) => r.team },
      { key: "calls", header: "Calls", numeric: true, render: (r) => r.calls },
      { key: "spend", header: "Spend", numeric: true, render: (r) => r.spend },
    ]}
    rows={rows}
    total={{ label: "Total", values: { calls: "2,056", spend: "$106.81" } }}
    caption="Metered calls, September 2026."
  />
);
