import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useEffect, useMemo, useState } from "react";
import {
  PACKAGE,
  QUOTE_DEBOUNCE_MS,
  TOKENS,
  TREASURY_BPS,
  type TokenConfig,
} from "../config";
import { createRpcPool, fromRaw, toRaw } from "../chain/rpc-pool";
import { useSlippage } from "../chain/slippage";
import { useAddress } from "../wallet/useConnect";

// Independent pool — Aggregator bursts several parallel quote calls
// (direct baseline + smart route + future external venues) and must
// not share a semaphore with Swap or Pools.
const rpc = createRpcPool("aggregator");

type VenueQuote = {
  venue: "Darbitex direct" | "Darbitex smart";
  pools: string[];
  outRaw: bigint;
  error?: string;
  loading: boolean;
};

export function AggregatorPage() {
  const { signAndSubmitTransaction } = useWallet();
  const address = useAddress();
  const [slippage] = useSlippage();
  const tokenList = useMemo(() => Object.values(TOKENS), []);

  const [tokenIn, setTokenIn] = useState<TokenConfig>(TOKENS.APT);
  const [tokenOut, setTokenOut] = useState<TokenConfig>(TOKENS.USDC);
  const [amountIn, setAmountIn] = useState("");
  const [quotes, setQuotes] = useState<VenueQuote[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setQuotes([]);
    setError(null);
    const numeric = Number(amountIn);
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    if (tokenIn.meta === tokenOut.meta) {
      setError("Select two different tokens");
      return;
    }

    let cancelled = false;
    const handle = setTimeout(async () => {
      const amountRaw = toRaw(numeric, tokenIn.decimals);
      setQuotes([
        { venue: "Darbitex direct", pools: [], outRaw: 0n, loading: true },
        { venue: "Darbitex smart", pools: [], outRaw: 0n, loading: true },
      ]);

      // Parallel independent calls — same pool, different functions.
      const direct = rpc
        .viewFn<[string]>(
          "pool_factory::canonical_pool_address_of",
          [],
          [tokenIn.meta, tokenOut.meta],
        )
        .then(async ([poolAddr]) => {
          if (!poolAddr || /^0x0+$/.test(String(poolAddr))) {
            return { pools: [] as string[], outRaw: 0n };
          }
          const [outStr] = await rpc.viewFn<[string]>(
            "arbitrage::quote_path",
            [],
            [[poolAddr], tokenIn.meta, amountRaw.toString()],
          );
          return { pools: [String(poolAddr)], outRaw: BigInt(outStr ?? "0") };
        })
        .then((r) => r)
        .catch((e: Error) => ({ pools: [] as string[], outRaw: 0n, error: e.message }));

      const smart = rpc
        .viewFn<[string[], string]>(
          "arbitrage::quote_best_path",
          [],
          [tokenIn.meta, tokenOut.meta, amountRaw.toString()],
        )
        .then(([pools, outStr]) => ({
          pools: pools ?? [],
          outRaw: BigInt(outStr ?? "0"),
        }))
        .catch((e: Error) => ({ pools: [] as string[], outRaw: 0n, error: e.message }));

      const [d, s] = await Promise.all([direct, smart]);
      if (cancelled) return;
      setQuotes([
        { venue: "Darbitex direct", loading: false, ...d },
        { venue: "Darbitex smart", loading: false, ...s },
      ]);
    }, QUOTE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [amountIn, tokenIn, tokenOut]);

  const best = useMemo(() => {
    return quotes
      .filter((q) => !q.loading && !q.error && q.outRaw > 0n)
      .sort((a, b) => (b.outRaw > a.outRaw ? 1 : b.outRaw < a.outRaw ? -1 : 0))[0];
  }, [quotes]);

  const surplus = useMemo(() => {
    if (!best) return null;
    const direct = quotes.find((q) => q.venue === "Darbitex direct");
    if (!direct || direct.outRaw === 0n) return null;
    if (best.outRaw <= direct.outRaw) return { amount: 0n, cut: 0n };
    const amount = best.outRaw - direct.outRaw;
    const cut = (amount * BigInt(TREASURY_BPS)) / 10_000n;
    return { amount, cut };
  }, [best, quotes]);

  async function submitBest() {
    if (!address || !best) return;
    setSubmitting(true);
    setError(null);
    setLastTx(null);
    try {
      const amountRaw = toRaw(Number(amountIn), tokenIn.decimals);
      const minOutRaw =
        (best.outRaw * BigInt(Math.floor((1 - slippage) * 1_000_000))) / 1_000_000n;
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const result = await signAndSubmitTransaction({
        data: {
          function: `${PACKAGE}::arbitrage::swap_entry`,
          typeArguments: [],
          functionArguments: [
            tokenIn.meta,
            tokenOut.meta,
            amountRaw.toString(),
            minOutRaw.toString(),
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

  return (
    <div className="container">
      <h1 className="page-title">Aggregator</h1>
      <p className="page-sub">
        Compare routing strategies across Darbitex internal venues. External venues (Hyperion,
        Thala, Cellana) will be wired in as independent quote columns.
      </p>

      <div className="swap-card">
        <div className="swap-row">
          <label>Input</label>
          <div className="swap-input">
            <input
              type="number"
              value={amountIn}
              onChange={(e) => setAmountIn(e.target.value)}
              placeholder="0.0"
              min="0"
            />
            <select
              className="token-select"
              value={tokenIn.symbol}
              onChange={(e) => {
                const next = tokenList.find((t) => t.symbol === e.target.value);
                if (next) setTokenIn(next);
              }}
            >
              {tokenList.map((t) => (
                <option key={t.symbol} value={t.symbol}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="swap-row">
          <label>Output token</label>
          <select
            className="token-select full"
            value={tokenOut.symbol}
            onChange={(e) => {
              const next = tokenList.find((t) => t.symbol === e.target.value);
              if (next) setTokenOut(next);
            }}
          >
            {tokenList.map((t) => (
              <option key={t.symbol} value={t.symbol}>
                {t.symbol}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="venue-table">
        <div className="venue-head">
          <span>Venue</span>
          <span>Route</span>
          <span>Output</span>
        </div>
        {quotes.length === 0 && <div className="venue-empty">Enter an amount to quote</div>}
        {quotes.map((q) => {
          const isBest = best && q.venue === best.venue;
          return (
            <div key={q.venue} className={`venue-row ${isBest ? "best" : ""}`}>
              <span className="venue-name">{q.venue}</span>
              <span className="venue-route">
                {q.loading ? "…" : q.error ? "error" : `${q.pools.length}-hop`}
              </span>
              <span className="venue-out">
                {q.loading
                  ? "…"
                  : q.error
                    ? "—"
                    : q.outRaw === 0n
                      ? "no route"
                      : fromRaw(q.outRaw, tokenOut.decimals).toFixed(6)}
              </span>
            </div>
          );
        })}
      </div>

      {surplus && surplus.amount > 0n && (
        <div className="surplus-note">
          Smart route surplus over direct baseline:{" "}
          <strong>+{fromRaw(surplus.amount, tokenOut.decimals).toFixed(6)}</strong>{" "}
          {tokenOut.symbol} · treasury cut (10%):{" "}
          {fromRaw(surplus.cut, tokenOut.decimals).toFixed(6)} {tokenOut.symbol}
        </div>
      )}
      {surplus && surplus.amount === 0n && best && (
        <div className="surplus-note dim">
          No surplus over direct baseline — zero treasury cut.
        </div>
      )}

      {error && <div className="err">{error}</div>}

      <button
        type="button"
        className="primary wide"
        disabled={!address || !best || submitting}
        onClick={submitBest}
      >
        {!address ? "Connect wallet" : submitting ? "Submitting…" : "Execute best route"}
      </button>

      {lastTx && (
        <div className="ok">
          Submitted:{" "}
          <a
            href={`https://explorer.aptoslabs.com/txn/${lastTx}?network=mainnet`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {lastTx.slice(0, 10)}…
          </a>
        </div>
      )}
    </div>
  );
}
