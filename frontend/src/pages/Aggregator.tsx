import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useEffect, useMemo, useState } from "react";
import { TokenIcon } from "../components/TokenIcon";
import {
  PACKAGE,
  QUOTE_DEBOUNCE_MS,
  TOKENS,
  TREASURY_BPS,
  type TokenConfig,
} from "../config";
import { useFaBalance } from "../chain/balance";
import { formatUsd, useAptPriceUsd, usdValueOf } from "../chain/prices";
import { createRpcPool, fromRaw, toRaw } from "../chain/rpc-pool";
import { useSlippage } from "../chain/slippage";
import { EXTERNAL_VENUES, type VenueAdapter } from "../chain/venues";
import { useAddress } from "../wallet/useConnect";

// Independent pool — Aggregator bursts several parallel quote calls
// (direct baseline + smart route + future external venues) and must
// not share a semaphore with Swap or Pools.
const rpc = createRpcPool("aggregator");

// Unified row shape for the quote table. Darbitex-internal rows are
// synthetic (no venue adapter), external venues are marshalled through
// their adapter's quote(). The `kind` discriminator tells submitBest
// which branch to take when the user hits Execute.
type QuoteRow =
  | {
      kind: "darbitex-direct";
      label: string;
      pools: string[];
      outRaw: bigint;
      loading: boolean;
      error?: string;
    }
  | {
      kind: "darbitex-smart";
      label: string;
      pools: string[];
      outRaw: bigint;
      loading: boolean;
      error?: string;
    }
  | {
      kind: "external";
      label: string;
      adapter: VenueAdapter;
      poolAddr?: string;
      routeLabel?: string;
      hops: number;
      outRaw: bigint;
      loading: boolean;
      error?: string;
    };

function seedRows(): QuoteRow[] {
  return [
    {
      kind: "darbitex-direct",
      label: "Darbitex direct",
      pools: [],
      outRaw: 0n,
      loading: true,
    },
    {
      kind: "darbitex-smart",
      label: "Darbitex smart",
      pools: [],
      outRaw: 0n,
      loading: true,
    },
    ...EXTERNAL_VENUES.map<QuoteRow>((v) => ({
      kind: "external",
      label: v.label,
      adapter: v,
      hops: 1,
      outRaw: 0n,
      loading: true,
    })),
  ];
}

export function AggregatorPage() {
  const { signAndSubmitTransaction, connected } = useWallet();
  const address = useAddress();
  const [slippage] = useSlippage();
  const aptPrice = useAptPriceUsd();
  const tokenList = useMemo(() => Object.values(TOKENS), []);

  const [tokenIn, setTokenIn] = useState<TokenConfig>(TOKENS.APT);
  const [tokenOut, setTokenOut] = useState<TokenConfig>(TOKENS.USDC);
  const balIn = useFaBalance(tokenIn.meta, tokenIn.decimals);
  const balOut = useFaBalance(tokenOut.meta, tokenOut.decimals);
  const [amountIn, setAmountIn] = useState("");
  const [rows, setRows] = useState<QuoteRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Warm external venue registries once per mount — they no-op on
  // subsequent calls.
  useEffect(() => {
    for (const v of EXTERNAL_VENUES) {
      v.warmup?.().catch(() => {});
    }
  }, []);

  useEffect(() => {
    setRows([]);
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
      setRows(seedRows());

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
        .catch((e: Error) => ({
          pools: [] as string[],
          outRaw: 0n,
          error: e.message,
        }));

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
        .catch((e: Error) => ({
          pools: [] as string[],
          outRaw: 0n,
          error: e.message,
        }));

      type ExternalProbe = {
        adapter: VenueAdapter;
        result:
          | {
              venue: string;
              amountOutRaw: bigint;
              poolAddr?: string;
              route?: string[];
              error?: string;
            }
          | null;
      };
      const externalProbes: Promise<ExternalProbe>[] = EXTERNAL_VENUES.map((v) =>
        v
          .quote(tokenIn, tokenOut, amountRaw)
          .then<ExternalProbe>((r) => ({ adapter: v, result: r }))
          .catch<ExternalProbe>((e: Error) => ({
            adapter: v,
            result: {
              venue: v.label,
              amountOutRaw: 0n,
              error: e.message,
            },
          })),
      );

      const [d, s, ...externals] = await Promise.all([
        direct,
        smart,
        ...externalProbes,
      ]);
      if (cancelled) return;

      setRows([
        {
          kind: "darbitex-direct",
          label: "Darbitex direct",
          loading: false,
          ...d,
        },
        {
          kind: "darbitex-smart",
          label: "Darbitex smart",
          loading: false,
          ...s,
        },
        ...externals.map<QuoteRow>(({ adapter, result }) => ({
          kind: "external",
          label: adapter.label,
          adapter,
          poolAddr: result?.poolAddr,
          routeLabel: result?.route?.[0],
          hops: 1,
          outRaw: result?.amountOutRaw ?? 0n,
          error: result?.error,
          loading: false,
        })),
      ]);
    }, QUOTE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [amountIn, tokenIn, tokenOut]);

  const best = useMemo(() => {
    return rows
      .filter((r) => !r.loading && !r.error && r.outRaw > 0n)
      .sort((a, b) => (b.outRaw > a.outRaw ? 1 : b.outRaw < a.outRaw ? -1 : 0))[0];
  }, [rows]);

  const surplus = useMemo(() => {
    if (!best) return null;
    const direct = rows.find((r) => r.kind === "darbitex-direct");
    if (!direct || direct.outRaw === 0n) return null;
    if (best.outRaw <= direct.outRaw) return { amount: 0n, cut: 0n };
    const amount = best.outRaw - direct.outRaw;
    const cut = (amount * BigInt(TREASURY_BPS)) / 10_000n;
    return { amount, cut };
  }, [best, rows]);

  async function submitBest() {
    if (!address || !best) return;
    setSubmitting(true);
    setError(null);
    setLastTx(null);
    try {
      const amountRaw = toRaw(Number(amountIn), tokenIn.decimals);
      const minOutRaw =
        (best.outRaw * BigInt(Math.floor((1 - slippage) * 1_000_000))) / 1_000_000n;
      const deadlineSecs = Math.floor(Date.now() / 1000) + 300;

      if (best.kind === "external") {
        const payload = best.adapter.buildSwapTx({
          tokenIn,
          tokenOut,
          amountInRaw: amountRaw,
          minOutRaw,
          deadlineSecs,
          quote: {
            venue: best.label,
            amountOutRaw: best.outRaw,
            poolAddr: best.poolAddr,
          },
        });
        const result = await signAndSubmitTransaction({
          data: {
            function: payload.function,
            typeArguments: payload.typeArguments,
            functionArguments:
              payload.functionArguments as unknown as string[],
          },
        });
        setLastTx(result.hash);
        balIn.refresh();
        balOut.refresh();
      } else {
        // Darbitex-internal: always through arbitrage::swap_entry so the
        // surplus rule applies uniformly, whether the winning path is
        // direct or smart-routed.
        const result = await signAndSubmitTransaction({
          data: {
            function: `${PACKAGE}::arbitrage::swap_entry`,
            typeArguments: [],
            functionArguments: [
              tokenIn.meta,
              tokenOut.meta,
              amountRaw.toString(),
              minOutRaw.toString(),
              deadlineSecs.toString(),
            ],
          },
        });
        setLastTx(result.hash);
        balIn.refresh();
        balOut.refresh();
      }
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
        Cross-venue quote comparison — Darbitex (direct + smart-routed) plus{" "}
        {EXTERNAL_VENUES.map((v) => v.label).join(" / ")}. Pick the best output and
        execute in one click.
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
            <span className="token-select-with-icon">
              <TokenIcon token={tokenIn} size={18} />
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
            </span>
          </div>
          {(() => {
            const n = Number(amountIn);
            const u = usdValueOf(n, tokenIn.symbol, aptPrice);
            return u !== null ? <div className="usd-value">≈ {formatUsd(u)}</div> : null;
          })()}
          {connected && (
            <div className="bal-static">
              Balance: {balIn.loading ? "…" : balIn.formatted.toFixed(6)} {tokenIn.symbol}
              {(() => {
                const u = usdValueOf(balIn.formatted, tokenIn.symbol, aptPrice);
                return u !== null ? <span className="usd-inline"> · {formatUsd(u)}</span> : null;
              })()}
            </div>
          )}
        </div>
        <div className="swap-row">
          <label>Output token</label>
          <span className="token-select-with-icon">
            <TokenIcon token={tokenOut} size={18} />
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
          </span>
          {connected && (
            <div className="bal-static">
              Balance: {balOut.loading ? "…" : balOut.formatted.toFixed(6)} {tokenOut.symbol}
              {(() => {
                const u = usdValueOf(balOut.formatted, tokenOut.symbol, aptPrice);
                return u !== null ? <span className="usd-inline"> · {formatUsd(u)}</span> : null;
              })()}
            </div>
          )}
        </div>
      </div>

      <div className="venue-table">
        <div className="venue-head">
          <span>Venue</span>
          <span>Route</span>
          <span>Output</span>
        </div>
        {rows.length === 0 && <div className="venue-empty">Enter an amount to quote</div>}
        {rows.map((r) => {
          const isBest = best && r.label === best.label;
          const outFormatted = r.loading || r.error || r.outRaw === 0n
            ? null
            : fromRaw(r.outRaw, tokenOut.decimals);
          const outUsd = outFormatted !== null
            ? usdValueOf(outFormatted, tokenOut.symbol, aptPrice)
            : null;
          const routeText = r.loading
            ? "…"
            : r.error
              ? "error"
              : r.kind === "external"
                ? r.routeLabel
                  ? r.routeLabel
                  : r.poolAddr
                    ? "1-hop"
                    : "—"
                : `${r.pools.length}-hop`;
          return (
            <div key={r.label} className={`venue-row ${isBest ? "best" : ""}`}>
              <span className="venue-name">{r.label}</span>
              <span className="venue-route">{routeText}</span>
              <span className="venue-out">
                {r.loading
                  ? "…"
                  : r.error
                    ? "—"
                    : r.outRaw === 0n
                      ? "no route"
                      : outFormatted!.toFixed(6)}
                {outUsd !== null && (
                  <span className="usd-inline"> · {formatUsd(outUsd)}</span>
                )}
              </span>
            </div>
          );
        })}
      </div>

      {surplus && surplus.amount > 0n && (
        <div className="surplus-note">
          Best route surplus over Darbitex direct baseline:{" "}
          <strong>+{fromRaw(surplus.amount, tokenOut.decimals).toFixed(6)}</strong>{" "}
          {tokenOut.symbol} · treasury cut only applies if the winner is a Darbitex
          route ({fromRaw(surplus.cut, tokenOut.decimals).toFixed(6)} {tokenOut.symbol}).
          External venues keep their own fee schedule; Darbitex takes nothing on routes
          it didn't improve.
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
