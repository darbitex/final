// ONE error codes from sources/ONE.move. Keep in sync with on-chain.
const ONE_ERRORS: Record<number, string> = {
  1: "Collateral below MCR (need ≥ 200% CR).",
  2: "Trove missing or already open.",
  3: "Debt below MIN_DEBT (1 ONE).",
  4: "Pyth price stale (≥60s). Refresh oracle and retry.",
  5: "Stability pool balance missing.",
  6: "Amount too small or zero.",
  7: "Target trove not found.",
  8: "Trove is healthy; cannot liquidate (CR ≥ 150%).",
  9: "Stability pool insufficient to absorb debt.",
  10: "Reserve insufficient for this reserve-redeem.",
  11: "Pyth returned zero price.",
  12: "Pyth exponent out of bound.",
  13: "Decimal overflow in math.",
  14: "Product-factor cliff hit. Re-deposit SP via fresh address.",
  15: "Pyth price exponent mismatch.",
  16: "Pyth price is negative.",
  17: "Caller is not origin (bootstrap only).",
  18: "ResourceCap already destroyed (sealed).",
  19: "Pyth confidence too low / uncertain.",
};

// Parse an Aptos Move-abort error message. Several shapes in the wild:
//   "Move abort in 0x85ee…::ONE: EDEBT_MIN(0x3): …"
//   "Move abort … code 3"
//   "execution failed … (code: 4)"
//   "{...\"abort_code\":\"3\"...}"
// Strategy: prefer explicit "code: N" or "abort_code: N" patterns. Fall back
// to the hex immediately after the module suffix (": 0x<code>") so we don't
// pick up hex chars inside the package address.
export function decodeOneError(err: unknown): string {
  const msg = String((err as { message?: string })?.message ?? err);

  const decimal = msg.match(/(?:abort_code|code)\s*[":=]?\s*"?(\d+)"?/i);
  if (decimal) {
    const code = parseInt(decimal[1], 10);
    if (ONE_ERRORS[code]) return `${ONE_ERRORS[code]} (code ${code})`;
  }

  const hexAfterColon = msg.match(/::\s*[A-Z_]*[a-zA-Z_]*\s*:\s*(?:E[A-Z_]+\s*\()?\s*0x([0-9a-fA-F]+)/);
  if (hexAfterColon) {
    const code = parseInt(hexAfterColon[1], 16);
    if (ONE_ERRORS[code]) return `${ONE_ERRORS[code]} (code ${code})`;
  }

  const bareHex = msg.match(/\babort[^0-9a-fx]*0x([0-9a-fA-F]{1,2})\b/i);
  if (bareHex) {
    const code = parseInt(bareHex[1], 16);
    if (ONE_ERRORS[code]) return `${ONE_ERRORS[code]} (code ${code})`;
  }

  return msg;
}
