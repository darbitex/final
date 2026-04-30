import { D_PARAMS } from "../config";

// Price feed returns 8 decimals per D's `price_8dec` view. Divide
// once, format with 4 fractional digits for display.
export function formatAptUsd(priceRaw: bigint): string {
  const n = Number(priceRaw) / 1e8;
  return `$${n.toFixed(4)}`;
}

export function formatD(raw: bigint, digits = 4): string {
  const n = Number(raw) / 10 ** D_PARAMS.D_DECIMALS;
  return n.toFixed(digits);
}

export function formatApt(raw: bigint, digits = 4): string {
  const n = Number(raw) / 10 ** D_PARAMS.APT_DECIMALS;
  return n.toFixed(digits);
}

// CR is in basis points per D's `trove_health` view (e.g. 20000 = 200%).
export function formatCrBps(crBps: bigint): string {
  if (crBps === 0n) return "∞";
  const pct = Number(crBps) / 100;
  return `${pct.toFixed(2)}%`;
}

export function collUsd(collateralRaw: bigint, priceRaw: bigint): number {
  return (
    (Number(collateralRaw) / 10 ** D_PARAMS.APT_DECIMALS) *
    (Number(priceRaw) / 1e8)
  );
}

export function debtUsd(debtRaw: bigint): number {
  return Number(debtRaw) / 10 ** D_PARAMS.D_DECIMALS;
}
