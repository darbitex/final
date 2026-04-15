import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useEffect, useMemo, useState } from "react";
import { PACKAGE, QUOTE_DEBOUNCE_MS, TOKENS, type TokenConfig } from "../config";
import { useFaBalance } from "../chain/balance";
import { formatUsd, useAptPriceUsd, usdValueOf } from "../chain/prices";
import { createRpcPool, fromRaw, toRaw } from "../chain/rpc-pool";
import { useSlippage } from "../chain/slippage";
import { useAddress } from "../wallet/useConnect";

// Each page owns its RPC pool — isolation means a burst here can't
// starve Pools / Aggregator / Portfolio on another tab.
const rpc = createRpcPool("swap");

type Side = "in" | "out";

export function SwapPage() {
  const { signAndSubmitTransaction, connected } = useWallet();
  const address = useAddress();
  const [slippage] = useSlippage();
  const tokenList = useMemo(() => Object.values(TOKENS), []);

  const [tokenIn, setTokenIn] = useState<TokenConfig>(TOKENS.APT);
  const [tokenOut, setTokenOut] = useState<TokenConfig>(TOKENS.USDC);
  const [amountIn, setAmountIn] = useState("");

  const balIn = useFaBalance(tokenIn.meta, tokenIn.decimals);
  const balOut = useFaBalance(tokenOut.meta, tokenOut.decimals);
  const aptPrice = useAptPriceUsd();
  const [quoting, setQuoting] = useState(false);
  const [quote, setQuote] = useState<{ pools: string[]; outRaw: bigint } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lastTx, setLastTx] = useState<string | null>(null);

  useEffect(() => {
    setQuote(null);
    setError(null);
    const numeric = Number(amountIn);
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    if (tokenIn.meta === tokenOut.meta) {
      setError("Select two different tokens");
      return;
    }
    const handle = setTimeout(async () => {
      setQuoting(true);
      try {
        const raw = toRaw(numeric, tokenIn.decimals);
        const res = await rpc.viewFn<[string[], string]>(
          "arbitrage::quote_best_path",
          [],
          [tokenIn.meta, tokenOut.meta, raw.toString()],
        );
        const pools = res[0] ?? [];
        const outRaw = BigInt(res[1] ?? "0");
        if (outRaw === 0n) {
          setError("No route found");
          setQuote(null);
        } else {
          setQuote({ pools, outRaw });
        }
      } catch (e) {
        setError((e as Error).message);
        setQuote(null);
      } finally {
        setQuoting(false);
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [amountIn, tokenIn, tokenOut]);

  function swapSides() {
    setTokenIn(tokenOut);
    setTokenOut(tokenIn);
    setAmountIn("");
  }

  async function submit() {
    if (!address || !quote) return;
    setSubmitting(true);
    setError(null);
    setLastTx(null);
    try {
      const amountRaw = toRaw(Number(amountIn), tokenIn.decimals);
      const minOutRaw =
        (quote.outRaw * BigInt(Math.floor((1 - slippage) * 1_000_000))) / 1_000_000n;
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
      balIn.refresh();
      balOut.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function setMaxIn() {
    if (balIn.raw === 0n) return;
    setAmountIn(String(balIn.formatted));
  }

  const outDisplay = quote ? fromRaw(quote.outRaw, tokenOut.decimals).toFixed(6) : "—";

  const inNum = Number(amountIn);
  const inUsd = usdValueOf(inNum, tokenIn.symbol, aptPrice);
  const outNum = quote ? fromRaw(quote.outRaw, tokenOut.decimals) : 0;
  const outUsd = quote ? usdValueOf(outNum, tokenOut.symbol, aptPrice) : null;

  return (
    <div className="container">
      <h1 className="page-title">Swap</h1>
      <p className="page-sub">
        Smart-routed through Darbitex pools. 1 bps LP fee; 10% on measurable surplus over the
        canonical direct baseline.
      </p>

      <div className="swap-card">
        <div className="swap-row">
          <label>You pay</label>
          <div className="swap-input">
            <input
              type="number"
              value={amountIn}
              onChange={(e) => setAmountIn(e.target.value)}
              placeholder="0.0"
              min="0"
            />
            <TokenSelect
              value={tokenIn}
              options={tokenList}
              onChange={setTokenIn}
              side="in"
            />
          </div>
          {inUsd !== null && <div className="usd-value">≈ {formatUsd(inUsd)}</div>}
          {connected && (
            <button
              type="button"
              className="bal-link"
              onClick={setMaxIn}
              disabled={balIn.raw === 0n}
            >
              Balance: {balIn.loading ? "…" : balIn.formatted.toFixed(6)} {tokenIn.symbol}
            </button>
          )}
        </div>

        <button type="button" className="swap-flip" onClick={swapSides} aria-label="Flip">
          ↓
        </button>

        <div className="swap-row">
          <label>You receive</label>
          <div className="swap-input">
            <input type="text" value={outDisplay} readOnly />
            <TokenSelect
              value={tokenOut}
              options={tokenList}
              onChange={setTokenOut}
              side="out"
            />
          </div>
          {outUsd !== null && <div className="usd-value">≈ {formatUsd(outUsd)}</div>}
          {connected && (
            <div className="bal-static">
              Balance: {balOut.loading ? "…" : balOut.formatted.toFixed(6)} {tokenOut.symbol}
            </div>
          )}
        </div>

        {quote && quote.pools.length > 0 && (
          <div className="route">
            <span className="route-label">Route</span>
            <span className="route-path">{quote.pools.length}-hop</span>
          </div>
        )}

        {quoting && <div className="hint">Quoting…</div>}
        {error && <div className="err">{error}</div>}

        <button
          type="button"
          className="primary"
          disabled={!address || !quote || submitting}
          onClick={submit}
        >
          {!address ? "Connect wallet" : submitting ? "Submitting…" : "Swap"}
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
    </div>
  );
}

function TokenSelect({
  value,
  options,
  onChange,
  side,
}: {
  value: TokenConfig;
  options: TokenConfig[];
  onChange: (t: TokenConfig) => void;
  side: Side;
}) {
  return (
    <select
      className="token-select"
      value={value.symbol}
      onChange={(e) => {
        const next = options.find((t) => t.symbol === e.target.value);
        if (next) onChange(next);
      }}
      aria-label={`Token ${side}`}
    >
      {options.map((t) => (
        <option key={t.symbol} value={t.symbol}>
          {t.symbol}
        </option>
      ))}
    </select>
  );
}
