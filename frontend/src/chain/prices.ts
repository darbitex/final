import { useEffect, useState } from "react";
import { TOKENS } from "../config";
import { createRpcPool } from "./rpc-pool";

// Dedicated pool — price fetches run on page mount and must not
// contend with the Swap page's own quote RPC pool.
const rpc = createRpcPool("prices");

// Symbols that are USD-pegged by construction (native USDC/USDt and
// LayerZero wrapped variants). Treated as $1 with no oracle call.
const STABLE_SYMBOLS = new Set(["USDC", "USDt", "lzUSDC", "lzUSDT"]);

// Module-level APT price cache. First consumer that calls
// `loadAptPriceUsd` triggers the fetch; subsequent callers reuse the
// in-flight promise or the cached value. Invalidates on page reload
// only — prices drift but within a session the variance is
// acceptable for the "≈ $X" display.
let aptPriceUsd: number | null = null;
let aptPricePromise: Promise<number | null> | null = null;

async function loadAptPriceUsd(): Promise<number | null> {
  if (aptPriceUsd !== null) return aptPriceUsd;
  if (aptPricePromise) return aptPricePromise;

  aptPricePromise = (async () => {
    try {
      const aptRaw = (10n ** BigInt(TOKENS.APT.decimals)).toString(); // 1 APT
      const [, out] = await rpc.viewFn<[string[], string]>(
        "arbitrage::quote_best_path",
        [],
        [TOKENS.APT.meta, TOKENS.USDC.meta, aptRaw],
      );
      const outRaw = BigInt(out ?? "0");
      if (outRaw === 0n) return null;
      // out is in USDC raw units (6 decimals)
      const price = Number(outRaw) / 10 ** TOKENS.USDC.decimals;
      aptPriceUsd = price;
      return price;
    } catch {
      return null;
    }
  })();

  return aptPricePromise;
}

// Pure-function USD conversion. Returns null for unknown tokens so
// the UI can render "—" or omit the line entirely.
export function usdValueOf(
  amount: number,
  symbol: string,
  aptPrice: number | null,
): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (STABLE_SYMBOLS.has(symbol)) return amount;
  if (symbol === "APT" && aptPrice !== null) return amount * aptPrice;
  return null;
}

export function formatUsd(value: number | null): string {
  if (value === null) return "";
  if (value < 0.01) return "< $0.01";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

// Fetches APT/USD on mount; re-renders once resolved. Returns `null`
// while loading (stables still render $1 immediately via usdValueOf).
export function useAptPriceUsd(): number | null {
  const [price, setPrice] = useState<number | null>(aptPriceUsd);
  useEffect(() => {
    if (price !== null) return;
    let cancelled = false;
    loadAptPriceUsd().then((p) => {
      if (!cancelled && p !== null) setPrice(p);
    });
    return () => {
      cancelled = true;
    };
  }, [price]);
  return price;
}
