import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useMemo, useState } from "react";
import { PACKAGE, TOKENS, type TokenConfig } from "../config";
import { formatUsd, useAptPriceUsd, usdValueOf } from "../chain/prices";
import { createRpcPool, fromRaw, toRaw } from "../chain/rpc-pool";
import { useAddress } from "../wallet/useConnect";

const rpc = createRpcPool("arbitrage");

type Mode = "flash" | "seed";

type CycleQuote = {
  pools: string[];
  outRaw: bigint;
  borrowPool?: string;
};

export function ArbitragePage() {
  const { signAndSubmitTransaction } = useWallet();
  const address = useAddress();
  const aptPrice = useAptPriceUsd();
  const tokenList = useMemo(() => Object.values(TOKENS), []);

  const [mode, setMode] = useState<Mode>("flash");
  const [anchor, setAnchor] = useState<TokenConfig>(TOKENS.APT);
  const [amount, setAmount] = useState("");
  const [minNetProfit, setMinNetProfit] = useState("0");
  const [scanning, setScanning] = useState(false);
  const [quote, setQuote] = useState<CycleQuote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lastTx, setLastTx] = useState<string | null>(null);

  async function scan() {
    setScanning(true);
    setError(null);
    setQuote(null);
    try {
      const numeric = Number(amount);
      if (!Number.isFinite(numeric) || numeric <= 0) {
        setError("Enter a positive amount");
        return;
      }
      const raw = toRaw(numeric, anchor.decimals);
      if (mode === "flash") {
        const res = await rpc.viewFn<[string, string[], string]>(
          "arbitrage::quote_best_flash_triangle",
          [],
          [anchor.meta, raw.toString()],
        );
        const borrowPool = String(res[0] ?? "");
        const pools = (res[1] ?? []).map(String);
        const outRaw = BigInt(res[2] ?? "0");
        if (!borrowPool || /^0x0+$/.test(borrowPool) || pools.length === 0) {
          setError("No profitable flash triangle found at this size");
          return;
        }
        setQuote({ pools, outRaw, borrowPool });
      } else {
        const res = await rpc.viewFn<[string[], string]>(
          "arbitrage::quote_best_cycle",
          [],
          [anchor.meta, raw.toString()],
        );
        const pools = (res[0] ?? []).map(String);
        const outRaw = BigInt(res[1] ?? "0");
        if (pools.length === 0 || outRaw <= raw) {
          setError("No profitable seed cycle found at this size");
          return;
        }
        setQuote({ pools, outRaw });
      }
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
      const numeric = Number(amount);
      const raw = toRaw(numeric, anchor.decimals);
      const minProfitRaw = toRaw(Number(minNetProfit) || 0, anchor.decimals);
      const deadline = Math.floor(Date.now() / 1000) + 300;

      const fnName = mode === "flash" ? "close_triangle_flash" : "close_triangle";
      const result = await signAndSubmitTransaction({
        data: {
          function: `${PACKAGE}::arbitrage::${fnName}`,
          typeArguments: [],
          functionArguments: [
            anchor.meta,
            raw.toString(),
            minProfitRaw.toString(),
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
      <h1 className="page-title">Arbitrage</h1>
      <p className="page-sub">
        On-chain triangle closure. Flash mode borrows against a pool, cycles the anchor, and
        repays in a single tx — zero up-front capital. Seed mode uses your own balance.
      </p>

      <div className="swap-card">
        <div className="mode-tabs">
          <button
            type="button"
            className={mode === "flash" ? "active" : ""}
            onClick={() => setMode("flash")}
          >
            Flash triangle
          </button>
          <button
            type="button"
            className={mode === "seed" ? "active" : ""}
            onClick={() => setMode("seed")}
          >
            Seed cycle
          </button>
        </div>

        <div className="swap-row">
          <label>Anchor asset</label>
          <select
            className="token-select full"
            value={anchor.symbol}
            onChange={(e) => {
              const next = tokenList.find((t) => t.symbol === e.target.value);
              if (next) setAnchor(next);
            }}
          >
            {tokenList.map((t) => (
              <option key={t.symbol} value={t.symbol}>
                {t.symbol}
              </option>
            ))}
          </select>
        </div>

        <div className="swap-row">
          <label>{mode === "flash" ? "Flash borrow amount" : "Seed amount"}</label>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
            min="0"
          />
        </div>

        <div className="swap-row">
          <label>Min net profit (after treasury cut)</label>
          <input
            type="number"
            value={minNetProfit}
            onChange={(e) => setMinNetProfit(e.target.value)}
            placeholder="0.0"
            min="0"
          />
        </div>

        <button
          type="button"
          className="primary"
          onClick={scan}
          disabled={scanning || !amount}
        >
          {scanning ? "Scanning…" : "Scan for profitable cycle"}
        </button>

        {quote && (() => {
          const outFormatted = fromRaw(quote.outRaw, anchor.decimals);
          const outUsd = usdValueOf(outFormatted, anchor.symbol, aptPrice);
          const inputNum = Number(amount);
          const inUsd = usdValueOf(inputNum, anchor.symbol, aptPrice);
          const profitFormatted = inputNum > 0 ? outFormatted - inputNum : 0;
          const profitUsd =
            outUsd !== null && inUsd !== null ? outUsd - inUsd : null;
          return (
          <div className="quote-box">
            <div>
              <span className="dim">Expected output</span>
              <strong>
                {outFormatted.toFixed(6)} {anchor.symbol}
                {outUsd !== null && (
                  <span className="usd-inline"> · {formatUsd(outUsd)}</span>
                )}
              </strong>
            </div>
            {profitFormatted !== 0 && (
              <div>
                <span className="dim">Gross delta</span>
                <strong>
                  {profitFormatted > 0 ? "+" : ""}
                  {profitFormatted.toFixed(6)} {anchor.symbol}
                  {profitUsd !== null && (
                    <span className="usd-inline"> · {formatUsd(profitUsd)}</span>
                  )}
                </strong>
              </div>
            )}
            <div>
              <span className="dim">Cycle length</span>
              <strong>{quote.pools.length} hops</strong>
            </div>
            {quote.borrowPool && (
              <div>
                <span className="dim">Flash source</span>
                <code>
                  {quote.borrowPool.slice(0, 10)}…{quote.borrowPool.slice(-4)}
                </code>
              </div>
            )}
          </div>
          );
        })()}

        {error && <div className="err">{error}</div>}

        <button
          type="button"
          className="primary"
          disabled={!address || !quote || submitting}
          onClick={execute}
        >
          {!address
            ? "Connect wallet"
            : submitting
              ? "Submitting…"
              : mode === "flash"
                ? "Execute flash triangle"
                : "Execute seed cycle"}
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
