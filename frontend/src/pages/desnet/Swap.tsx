import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useAddress } from "../../wallet/useConnect";
import { useFaBalance } from "../../chain/balance";
import { createRpcPool, fromRaw, toRaw } from "../../chain/rpc-pool";
import { DESNET_PACKAGE, SLIPPAGE, TOKENS } from "../../config";
import {
  computeAmountOut,
  reserves,
  tokenMetadataAddr,
} from "../../chain/desnet/amm";
import {
  handleBytes,
  isHandleRegistered,
  validateHandle,
} from "../../chain/desnet/profile";
import { APT_VIEW, useTokenView } from "../../chain/desnet/tokenIcon";
import { TokenIcon } from "../../components/TokenIcon";
import { formatNumberForInput } from "../../chain/desnet/format";
import { formatUsd, useAptPriceUsd, usdValueOf } from "../../chain/prices";

const APT = TOKENS.APT;
const rpc = createRpcPool("desnet-swap");

const SWAP_APT_FOR_TOKEN_FN = `${DESNET_PACKAGE}::amm::swap_apt_for_token`;
const SWAP_TOKEN_FOR_APT_FN = `${DESNET_PACKAGE}::amm::swap_token_for_apt`;

const HANDLE_DEBOUNCE_MS = 350;
const QUICK_HANDLES = ["desnet", "darbitex", "aptos", "apt", "d"];

export function Swap() {
  const address = useAddress();
  const { signAndSubmitTransaction, connected } = useWallet();
  const aptPrice = useAptPriceUsd();

  const [handle, setHandle] = useState("desnet");
  const [resolvedHandle, setResolvedHandle] = useState<string | null>("desnet");
  const [tokenMeta, setTokenMeta] = useState<string | null>(null);
  const [tokenSymbol, setTokenSymbol] = useState<string>("DESNET");
  const [poolReserves, setPoolReserves] = useState<{ apt: bigint; token: bigint } | null>(null);

  const [aptToToken, setAptToToken] = useState(true);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [lastTx, setLastTx] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const aptBal = useFaBalance(APT.meta, APT.decimals);
  const tokenBal = useFaBalance(tokenMeta, 8);
  const tokenView = useTokenView(tokenMeta);

  const handleErr = useMemo(() => (handle ? validateHandle(handle) : null), [handle]);

  // Resolve handle → tokenMeta + reserves whenever the handle stabilises.
  useEffect(() => {
    setResolvedHandle(null);
    setTokenMeta(null);
    setPoolReserves(null);
    if (!handle || handleErr) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const taken = await isHandleRegistered(rpc, handle);
        if (!taken) {
          if (!cancelled) setError(`@${handle} is not registered`);
          return;
        }
        const meta = await tokenMetadataAddr(rpc, handle);
        if (cancelled) return;
        setTokenMeta(meta);
        setTokenSymbol(handle.toUpperCase());
        setResolvedHandle(handle);
        setError(null);
        const [aR, tR] = await reserves(rpc, handle);
        if (!cancelled) setPoolReserves({ apt: aR, token: tR });
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? String(e));
      }
    }, HANDLE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [handle, handleErr]);

  const amountInRaw = useMemo(() => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return 0n;
    return toRaw(n, 8); // both sides use 8 decimals
  }, [amount]);

  const amountOutRaw = useMemo(() => {
    if (!poolReserves || amountInRaw <= 0n) return 0n;
    if (aptToToken) return computeAmountOut(poolReserves.apt, poolReserves.token, amountInRaw);
    return computeAmountOut(poolReserves.token, poolReserves.apt, amountInRaw);
  }, [poolReserves, amountInRaw, aptToToken]);

  const minOutRaw = useMemo(() => {
    if (amountOutRaw <= 0n) return 0n;
    const denom = 10_000n;
    const slip = BigInt(Math.round(SLIPPAGE * Number(denom)));
    return (amountOutRaw * (denom - slip)) / denom;
  }, [amountOutRaw]);

  const fromBal = aptToToken ? aptBal : tokenBal;
  const toBal = aptToToken ? tokenBal : aptBal;
  const insufficient = fromBal.raw < amountInRaw;
  const inSymbol = aptToToken ? "APT" : `$${tokenSymbol}`;
  const outSymbol = aptToToken ? `$${tokenSymbol}` : "APT";
  const inView = aptToToken ? APT_VIEW : tokenView;
  const outView = aptToToken ? tokenView : APT_VIEW;
  const outFormatted = amountOutRaw > 0n ? Number(fromRaw(amountOutRaw, 8)).toFixed(6) : "";

  // USD display only available for APT side (price feed)
  const inUsd = aptToToken ? usdValueOf(Number(amount), "APT", aptPrice) : null;
  const outUsd = !aptToToken && amountOutRaw > 0n
    ? usdValueOf(Number(fromRaw(amountOutRaw, 8)), "APT", aptPrice)
    : null;

  async function submit() {
    if (!resolvedHandle || amountInRaw <= 0n) return;
    setError(null);
    setLastTx(null);
    setSubmitting(true);
    try {
      const fn = aptToToken ? SWAP_APT_FOR_TOKEN_FN : SWAP_TOKEN_FOR_APT_FN;
      const result = await signAndSubmitTransaction({
        data: {
          function: fn,
          typeArguments: [],
          functionArguments: [
            handleBytes(resolvedHandle),
            amountInRaw.toString(),
            minOutRaw.toString(),
          ],
        },
      });
      setLastTx(result.hash);
      setAmount("");
      aptBal.refresh();
      tokenBal.refresh();
      const [aR, tR] = await reserves(rpc, resolvedHandle);
      setPoolReserves({ apt: aR, token: tR });
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit =
    !!address && !!resolvedHandle && amountInRaw > 0n && !insufficient && !submitting;

  return (
    <>
      <h2 className="page-title">Swap APT ↔ $TOKEN</h2>
      <p className="page-sub">
        Per-handle AMM. 10 bps fee, 100% to LP. Type a handle below or pick a quick choice.
      </p>

      <div className="swap-card">
        {/* Handle picker — similar to Darbitex Trade's "venue" selector */}
        <div className="swap-row">
          <label>Token (DeSNet handle)</label>
          <div className="swap-input">
            <input
              value={handle}
              onChange={(e) => setHandle(e.target.value.toLowerCase().trim())}
              placeholder="desnet"
              style={{ flex: 1 }}
            />
            <span className="token-select-with-icon">
              <TokenIcon token={tokenView} size={18} />
              <span className="token-select" style={{ fontWeight: 600 }}>
                ${tokenSymbol}
              </span>
            </span>
          </div>
          <div style={{ marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span className="muted small">Quick:</span>
            {QUICK_HANDLES.map((q) => (
              <button
                key={q}
                type="button"
                className="link small"
                onClick={() => setHandle(q)}
                style={{
                  padding: "2px 8px",
                  borderRadius: 8,
                  background: handle === q ? "#1a4480" : "transparent",
                  color: handle === q ? "#fff" : undefined,
                  border: "1px solid #444",
                }}
              >
                ${q}
              </button>
            ))}
          </div>
          {handleErr && <small className="error">{handleErr}</small>}
          {poolReserves && (
            <small className="muted" style={{ marginTop: 4, display: "block" }}>
              Pool: <strong>{Number(fromRaw(poolReserves.apt, 8)).toLocaleString()}</strong> APT ·{" "}
              <strong>{Number(fromRaw(poolReserves.token, 8)).toLocaleString()}</strong> ${tokenSymbol}
            </small>
          )}
        </div>

        {/* Input row */}
        <div className="swap-row">
          <label>From</label>
          <div className="swap-input">
            <input
              type="number"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              min="0"
              step="any"
            />
            <span className="token-select-with-icon">
              <TokenIcon token={inView} size={18} />
              <span className="token-select" style={{ fontWeight: 600 }}>
                {inSymbol}
              </span>
            </span>
          </div>
          {inUsd !== null && (
            <div className="usd-value">≈ {formatUsd(inUsd)}</div>
          )}
          {connected && (
            <button
              type="button"
              className="bal-link"
              onClick={() => fromBal.raw > 0n && setAmount(formatNumberForInput(fromBal.formatted))}
              disabled={fromBal.raw === 0n}
            >
              Balance: {fromBal.loading ? "…" : fromBal.formatted.toFixed(6)} {inSymbol}
            </button>
          )}
        </div>

        {/* Flip button — visual divider between input/output */}
        <div style={{ display: "flex", justifyContent: "center", margin: "4px 0" }}>
          <button
            type="button"
            className="link"
            onClick={() => setAptToToken((v) => !v)}
            aria-label="Flip swap direction"
            style={{
              padding: "4px 10px",
              borderRadius: 12,
              border: "1px solid #444",
              background: "#0a0a0a",
            }}
            title="Flip direction"
          >
            ↕
          </button>
        </div>

        {/* Output row */}
        <div className="swap-row">
          <label>To (estimated)</label>
          <div className="swap-input">
            <input
              type="text"
              readOnly
              value={outFormatted}
              placeholder="0.0"
            />
            <span className="token-select-with-icon">
              <TokenIcon token={outView} size={18} />
              <span className="token-select" style={{ fontWeight: 600 }}>
                {outSymbol}
              </span>
            </span>
          </div>
          {outUsd !== null && (
            <div className="usd-value">≈ {formatUsd(outUsd)}</div>
          )}
          {connected && (
            <div className="bal-static">
              Balance: {toBal.loading ? "…" : toBal.formatted.toFixed(6)} {outSymbol}
            </div>
          )}
        </div>
      </div>

      {/* Slippage + min-out summary, mirroring Trade.tsx layout */}
      {amountOutRaw > 0n && (
        <div className="venue-table" style={{ marginTop: 12 }}>
          <div className="venue-row">
            <span className="venue-name">Min received ({(SLIPPAGE * 100).toFixed(2)}% slip)</span>
            <span className="venue-route">{aptToToken ? `→ ${tokenSymbol}` : `→ APT`}</span>
            <span className="venue-out">
              <strong>{Number(fromRaw(minOutRaw, 8)).toFixed(6)}</strong> {outSymbol}
            </span>
          </div>
        </div>
      )}

      {!address && <p className="muted" style={{ marginTop: 12 }}>Connect a wallet to swap.</p>}
      {address && insufficient && amountInRaw > 0n && (
        <p className="error" style={{ marginTop: 12 }}>Insufficient {inSymbol} balance.</p>
      )}

      <button
        className="primary"
        disabled={!canSubmit}
        onClick={submit}
        style={{ marginTop: 12, width: "100%", padding: "12px" }}
      >
        {submitting ? "Swapping…" : `Swap ${inSymbol} → ${outSymbol}`}
      </button>

      {lastTx && (
        <p className="ok" style={{ marginTop: 8 }}>
          Sent.{" "}
          <a
            href={`https://explorer.aptoslabs.com/txn/${lastTx}?network=mainnet`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {lastTx.slice(0, 10)}…
          </a>
        </p>
      )}
      {error && <p className="error" style={{ marginTop: 8 }}>{error}</p>}
    </>
  );
}
