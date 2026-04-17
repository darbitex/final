// Hyperion cross-tier flash arb panel. Parallels the keeper bot's
// flash_arb_cross_tier logic but with manual trigger UI.
// Anchor = Aave-supported asset we flash (APT or native stables).
// Scans 6 Hyperion tiers of the chosen pair, finds best (pool_buy, pool_sell)
// combo where round-trip profit > 0. User signs the flash_arb_cross_tier tx.

import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useMemo, useState } from "react";
import {
  AGGREGATOR_PACKAGE,
  HYPERION_ROUTER_PACKAGE,
  TOKENS,
  type TokenConfig,
} from "../config";
import { createRpcPool, fromRaw, toRaw } from "../chain/rpc-pool";
import { formatUsd, useAptPriceUsd, usdValueOf } from "../chain/prices";
import { useAddress } from "../wallet/useConnect";
import { TokenIcon } from "./TokenIcon";

const rpc = createRpcPool("hyperion-router");

// Aave Aptos supports APT + native stables for flash (0% fee)
const AAVE_SUPPORTED_SYMBOLS = ["APT", "USDC", "USDt"] as const;

type TierQuote = {
  tier: number;
  pool: string;
  outRaw: bigint;
};

type ArbQuote = {
  anchor: TokenConfig;
  pair: TokenConfig;  // the "other" side
  borrowRaw: bigint;
  poolBuy: { tier: number; pool: string; reserveAnchor: bigint };
  poolSell: { tier: number; pool: string; reserveAnchor: bigint };
  expectedProfitRaw: bigint;
  aToBBuy: boolean;
  aToBSell: boolean;
  poolConsumptionPct: number;  // borrow size as % of smaller pool's anchor reserve
};

// Derive a_to_b for a swap `from → to` based on canonical (lex) sort
// Hyperion stores smaller address as token_a; a_to_b=true means a→b
function direction(from: string, to: string): boolean {
  return from.toLowerCase() < to.toLowerCase();
}

async function poolExists(metaA: string, metaB: string, tier: number): Promise<string | null> {
  try {
    const ex = await rpc.viewFn<[boolean]>(
      "aggregator::hyperion_pool_exists", [], [metaA, metaB, tier], AGGREGATOR_PACKAGE,
    );
    if (!ex[0]) return null;
    const p = await rpc.viewFn<[string]>(
      "aggregator::hyperion_get_pool", [], [metaA, metaB, tier], AGGREGATOR_PACKAGE,
    );
    return String(p[0]);
  } catch {
    return null;
  }
}

async function poolReserves(pool: string): Promise<[bigint, bigint] | null> {
  try {
    const r = await rpc.viewFn<[string, string]>(
      "aggregator::hyperion_reserves", [], [pool], AGGREGATOR_PACKAGE,
    );
    return [BigInt(r[0]), BigInt(r[1])];
  } catch {
    return null;
  }
}

// Hyperion stores reserves as (r0, r1) where r0 is lex-smaller address.
// Given anchor+pair, return how much of anchor token the pool holds.
function anchorReserve(reserves: [bigint, bigint], anchor: string, pair: string): bigint {
  return anchor.toLowerCase() < pair.toLowerCase() ? reserves[0] : reserves[1];
}

async function quotePool(pool: string, tokenIn: string, amountIn: string): Promise<bigint | null> {
  try {
    const q = await rpc.viewFn<[string]>(
      "aggregator::quote_hyperion", [], [pool, tokenIn, amountIn], AGGREGATOR_PACKAGE,
    );
    return BigInt(q[0] ?? "0");
  } catch {
    return null;
  }
}

export function HyperionRouterPanel() {
  const { signAndSubmitTransaction } = useWallet();
  const address = useAddress();
  const aptPrice = useAptPriceUsd();

  const anchorChoices = useMemo(
    () => Object.values(TOKENS).filter((t) => (AAVE_SUPPORTED_SYMBOLS as readonly string[]).includes(t.symbol)),
    [],
  );
  const pairChoices = useMemo(
    () => Object.values(TOKENS),
    [],
  );

  const [anchor, setAnchor] = useState<TokenConfig>(anchorChoices[0] ?? TOKENS.APT);
  const [pair, setPair] = useState<TokenConfig>(TOKENS.USDC);
  const [amount, setAmount] = useState("");
  const [scanning, setScanning] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [quote, setQuote] = useState<ArbQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [scanLog, setScanLog] = useState<string[]>([]);

  async function scan() {
    setScanning(true);
    setError(null);
    setQuote(null);
    setLastTx(null);
    setScanLog([]);
    const log = (line: string) => setScanLog((prev) => [...prev, line]);
    try {
      const numeric = Number(amount);
      if (!Number.isFinite(numeric) || numeric <= 0) { setError("Enter positive amount"); return; }
      if (anchor.meta === pair.meta) { setError("Anchor and pair must differ"); return; }
      const borrowRaw = toRaw(numeric, anchor.decimals);

      log(`Probing 6 tiers for ${anchor.symbol}/${pair.symbol}…`);
      const tiers = await Promise.all(
        [0, 1, 2, 3, 4, 5].map((t) => poolExists(anchor.meta, pair.meta, t).then((pool) => ({ tier: t, pool }))),
      );
      const active = tiers.filter((x): x is { tier: number; pool: string } => !!x.pool);
      log(`Found ${active.length} tier(s) with pools: ${active.map((x) => `tier ${x.tier}`).join(", ")}`);
      if (active.length < 2) { setError(`Need ≥2 tiers with liquidity, found ${active.length}`); return; }

      // Fetch reserves for each active tier (for depth display + borrow-cap sanity)
      const reservesByPool = new Map<string, [bigint, bigint]>();
      await Promise.all(active.map(async (t) => {
        const r = await poolReserves(t.pool);
        if (r) reservesByPool.set(t.pool, r);
      }));

      // Soft cap warning: if borrow > 5% of smallest tier's anchor reserve, warn (but don't block)
      const anchorReserves = active.map((t) => {
        const r = reservesByPool.get(t.pool);
        return r ? anchorReserve(r, anchor.meta, pair.meta) : 0n;
      }).filter((x) => x > 0n);
      if (anchorReserves.length > 0) {
        const minReserve = anchorReserves.reduce((a, b) => (a < b ? a : b));
        const pct = minReserve > 0n ? Number(borrowRaw * 10000n / minReserve) / 100 : 0;
        log(`Smallest tier anchor depth: ${fromRaw(minReserve, anchor.decimals).toFixed(4)} ${anchor.symbol} (borrow is ${pct.toFixed(2)}% of it)`);
        if (pct > 20) log(`⚠️ Borrow >20% of smallest pool — high slippage likely`);
      }

      log(`Quoting ${anchor.symbol} → ${pair.symbol} across tiers…`);
      const buyQuotes = await Promise.all(
        active.map(async (t) => {
          const out = await quotePool(t.pool, anchor.meta, borrowRaw.toString());
          return { tier: t.tier, pool: t.pool, outRaw: out ?? 0n } as TierQuote;
        }),
      );
      const validBuys = buyQuotes.filter((q) => q.outRaw > 0n);
      validBuys.forEach((q) => log(`  tier ${q.tier}: ${fromRaw(q.outRaw, pair.decimals).toFixed(6)} ${pair.symbol}`));

      log(`Testing reverse quotes (${validBuys.length} × ${active.length - 1} combos)…`);
      let bestProfit = 0n;
      let best: ArbQuote | null = null;
      for (const tBuy of validBuys) {
        for (const tSell of active) {
          if (tSell.tier === tBuy.tier) continue;
          const backOut = await quotePool(tSell.pool, pair.meta, tBuy.outRaw.toString());
          if (!backOut || backOut <= borrowRaw) continue;
          const profit = backOut - borrowRaw;
          if (profit > bestProfit) {
            bestProfit = profit;
            const buyRes = reservesByPool.get(tBuy.pool);
            const sellRes = reservesByPool.get(tSell.pool);
            const buyAnchor = buyRes ? anchorReserve(buyRes, anchor.meta, pair.meta) : 0n;
            const sellAnchor = sellRes ? anchorReserve(sellRes, anchor.meta, pair.meta) : 0n;
            const smaller = buyAnchor < sellAnchor ? buyAnchor : sellAnchor;
            const pct = smaller > 0n ? Number(borrowRaw * 10000n / smaller) / 100 : 0;
            best = {
              anchor,
              pair,
              borrowRaw,
              poolBuy: { tier: tBuy.tier, pool: tBuy.pool, reserveAnchor: buyAnchor },
              poolSell: { tier: tSell.tier, pool: tSell.pool, reserveAnchor: sellAnchor },
              expectedProfitRaw: profit,
              aToBBuy: direction(anchor.meta, pair.meta),
              aToBSell: direction(pair.meta, anchor.meta),
              poolConsumptionPct: pct,
            };
          }
        }
      }

      if (!best) { log(`No profitable round-trip at this size`); setError("No profitable cross-tier cycle at this size"); return; }
      log(`🎯 Best: tier ${best.poolBuy.tier} → tier ${best.poolSell.tier}, profit +${fromRaw(best.expectedProfitRaw, anchor.decimals).toFixed(6)} ${anchor.symbol}`);
      setQuote(best);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  }

  async function execute() {
    if (!address || !quote) return;
    setSubmitting(true);
    setError(null);
    setLastTx(null);
    try {
      const deadline = Math.floor(Date.now() / 1000) + 300;
      // min_profit = 50% of expected (pool movement buffer)
      const minProfit = quote.expectedProfitRaw / 2n;
      const result = await signAndSubmitTransaction({
        data: {
          function: `${HYPERION_ROUTER_PACKAGE}::router::flash_arb_cross_tier`,
          typeArguments: [],
          functionArguments: [
            quote.anchor.meta,
            quote.borrowRaw.toString(),
            quote.poolBuy.pool, quote.aToBBuy,
            quote.poolSell.pool, quote.aToBSell,
            minProfit.toString(),
            deadline.toString(),
          ],
        },
      });
      setLastTx(result.hash);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  const profitDisplay = quote ? fromRaw(quote.expectedProfitRaw, anchor.decimals) : 0;
  const profitUsd = quote ? usdValueOf(profitDisplay, anchor.symbol, aptPrice) : null;

  return (
    <div className="swap-card" style={{ marginTop: "1.5rem" }}>
      <h2 style={{ marginTop: 0 }}>Hyperion Cross-Tier Flash Arb</h2>
      <p className="page-sub">
        Scans 6 Hyperion fee tiers for a profitable round-trip. Aave V3 flash loan (0% fee) funds
        the borrow. Router satellite executes atomically — tx aborts if profit below threshold.
      </p>

      <div className="swap-row">
        <label>Anchor (Aave-supported)</label>
        <span className="token-select-with-icon">
          <TokenIcon token={anchor} size={18} />
          <select className="token-select full" value={anchor.symbol}
            onChange={(e) => {
              const t = anchorChoices.find((x) => x.symbol === e.target.value);
              if (t) setAnchor(t);
            }}>
            {anchorChoices.map((t) => (<option key={t.symbol} value={t.symbol}>{t.symbol}</option>))}
          </select>
        </span>
      </div>

      <div className="swap-row">
        <label>Pair</label>
        <span className="token-select-with-icon">
          <TokenIcon token={pair} size={18} />
          <select className="token-select full" value={pair.symbol}
            onChange={(e) => {
              const t = pairChoices.find((x) => x.symbol === e.target.value);
              if (t) setPair(t);
            }}>
            {pairChoices.map((t) => (<option key={t.symbol} value={t.symbol}>{t.symbol}</option>))}
          </select>
        </span>
      </div>

      <div className="swap-row">
        <label>Flash borrow amount</label>
        <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)}
          placeholder="0.0" min="0" />
      </div>

      <button type="button" className="primary" onClick={scan} disabled={scanning || !amount}>
        {scanning ? "Scanning…" : "Scan cross-tier spread"}
      </button>

      {scanLog.length > 0 && (
        <div className="quote-box" style={{ fontFamily: "monospace", fontSize: "0.85em" }}>
          {scanLog.map((l, i) => <div key={i} className="dim">{l}</div>)}
        </div>
      )}

      {quote && (
        <div className="quote-box">
          <div>
            <span className="dim">Route</span>
            <strong>tier {quote.poolBuy.tier} buy → tier {quote.poolSell.tier} sell</strong>
          </div>
          <div>
            <span className="dim">Expected profit</span>
            <strong>
              +{profitDisplay.toFixed(6)} {anchor.symbol}
              {profitUsd !== null && <span className="usd-inline"> · {formatUsd(profitUsd)}</span>}
            </strong>
          </div>
          <div>
            <span className="dim">Min profit (50% tolerance)</span>
            <strong>{fromRaw(quote.expectedProfitRaw / 2n, anchor.decimals).toFixed(6)} {anchor.symbol}</strong>
          </div>
          <div>
            <span className="dim">Pool depth usage</span>
            <strong style={{ color: quote.poolConsumptionPct > 20 ? "#ff8800" : undefined }}>
              {quote.poolConsumptionPct.toFixed(2)}% of smaller tier
              {quote.poolConsumptionPct > 20 && " ⚠️"}
            </strong>
          </div>
        </div>
      )}

      {error && <div className="err">{error}</div>}

      <button type="button" className="primary" disabled={!address || !quote || submitting}
        onClick={execute}>
        {!address ? "Connect wallet" : submitting ? "Submitting…" : "Execute cross-tier flash arb"}
      </button>

      {lastTx && (
        <div className="ok">
          Submitted:{" "}
          <a href={`https://explorer.aptoslabs.com/txn/${lastTx}?network=mainnet`}
             target="_blank" rel="noopener noreferrer">
            {lastTx.slice(0, 10)}…
          </a>
        </div>
      )}
    </div>
  );
}
