/** Energy performance contract (EPC) and self-funded economics of a retrofit. */

export interface EpcInputs {
  /** verified annual saving in kWh */
  annualKwh: number;
  /** price per kWh */
  tariff: number;
  /** share of the projected saving actually achieved (0..1) */
  achieved: number;
  /** upfront investment, paid by the ESCO under an EPC */
  capex: number;
  /** ESCO share of verified savings (0..1) */
  escoShare: number;
  /** contract length in years */
  years: number;
  /** annual discount rate for NPV, e.g. 0.06 */
  discountRate?: number;
  /** annual O&M cost borne by the ESCO */
  annualOpex?: number;
}

export interface EpcYear {
  year: number;
  saving: number;
  ownerCumulative: number;
  escoCumulative: number;
}

export interface EpcResult {
  annualSaving: number;
  ownerAnnual: number;
  escoAnnual: number;
  /** years until the ESCO recovers capex; Infinity if never */
  escoPaybackYears: number;
  /** years until an owner paying the capex itself would recover it */
  selfFundedPaybackYears: number;
  escoNpv: number;
  ownerNpv: number;
  contractValue: number;
  timeline: EpcYear[];
}

export function evaluateEpc(i: EpcInputs): EpcResult {
  if (i.escoShare < 0 || i.escoShare > 1) throw new Error("escoShare must be within 0..1");
  if (i.achieved < 0) throw new Error("achieved must be ≥ 0");
  const rate = i.discountRate ?? 0.06;
  const opex = i.annualOpex ?? 0;
  const annualSaving = i.annualKwh * i.tariff * i.achieved;
  const ownerAnnual = annualSaving * (1 - i.escoShare);
  const escoAnnual = annualSaving * i.escoShare - opex;
  const timeline: EpcYear[] = [];
  let owner = 0;
  let esco = -i.capex;
  let escoNpv = -i.capex;
  let ownerNpv = 0;
  for (let y = 1; y <= i.years; y++) {
    owner += ownerAnnual;
    esco += escoAnnual;
    const df = (1 + rate) ** y;
    escoNpv += escoAnnual / df;
    ownerNpv += ownerAnnual / df;
    timeline.push({ year: y, saving: annualSaving, ownerCumulative: owner, escoCumulative: esco });
  }
  return {
    annualSaving,
    ownerAnnual,
    escoAnnual,
    escoPaybackYears: escoAnnual > 0 ? i.capex / escoAnnual : Number.POSITIVE_INFINITY,
    selfFundedPaybackYears: annualSaving > opex ? i.capex / (annualSaving - opex) : Number.POSITIVE_INFINITY,
    escoNpv,
    ownerNpv,
    contractValue: annualSaving * i.years,
    timeline,
  };
}
