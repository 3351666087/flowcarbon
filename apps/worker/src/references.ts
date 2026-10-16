/**
 * The only sources the AI assistant may cite. Keeping the list closed means a citation can always be checked;
 * the assistant cannot invent a standard. Extend it deliberately, with the exact document title.
 */
export const REFERENCES = {
  "gb-50189-2015": {
    title: "GB 50189-2015 Design standard for energy efficiency of public buildings (公共建筑节能设计标准)",
    note: "National mandatory standard for HVAC and lighting efficiency in public buildings, including offices; requires zoned HVAC control and lighting controls.",
  },
  "gov-ac-26c-2007": {
    title:
      "General Office of the State Council notice on strictly implementing the temperature control standard for air conditioning in public buildings (国办发〔2007〕42号)",
    note: "Public-building cooling set-points no lower than 26 °C in summer and heating no higher than 20 °C in winter.",
  },
  "ashrae-90-1-occupancy": {
    title: "ANSI/ASHRAE/IES Standard 90.1, automatic lighting shutoff and occupancy-based controls",
    note: "Requires automatic shut-off of lighting when spaces are unoccupied (occupant sensors within 20 minutes of vacancy) and allows occupancy-based HVAC setback.",
  },
  "iso-50001": {
    title: "ISO 50001 Energy management systems",
    note: "Energy reviews identify significant energy uses and opportunities; actions are verified against a baseline.",
  },
  ipmvp: {
    title: "International Performance Measurement and Verification Protocol (IPMVP), EVO",
    note: "Savings under an energy performance contract are verified against an adjusted baseline (option B or C for building systems).",
  },
  "ghg-scope2": {
    title: "GHG Protocol Scope 2 Guidance (2015)",
    note: "Electricity emissions are reported by both the location-based and the market-based method.",
  },
  "sse-guideline-14": {
    title: "Shanghai Stock Exchange Self-Regulatory Guideline No. 14 — Sustainability Report (Trial)",
    note: "Listed companies disclose energy use and greenhouse-gas emissions in the environmental part of the sustainability report.",
  },
  "flowcarbon-rule-rationale": {
    title: "FlowCarbon rule catalogue and threshold rationale (this building's parameters)",
    note: "The rule that produced the finding, its thresholds and why they were chosen.",
  },
} as const;

export type ReferenceId = keyof typeof REFERENCES;
export const REFERENCE_IDS = Object.keys(REFERENCES) as [ReferenceId, ...ReferenceId[]];
