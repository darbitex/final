// DesnetArbPanel — atomic 2-leg APT arb between DeSNet AMM and Darbitex AMM.
//
// Uses a precompiled Move script bundled in /public/scripts/. No on-chain
// package deploy required. Frontend-only orchestration: user signs ONE tx,
// both legs revert together if profit < min_profit.
//
// Capital model: user pays apt_in upfront from their primary store (no flash
// loan). User keeps 100% of profit (no protocol cut). Profit floor enforced
// inside the script via balance-delta snapshot.

import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { TOKENS } from "../config";
import { useFaBalance } from "../chain/balance";
import { useTokenView } from "../chain/desnet/tokenIcon";
import { formatUsd, useAptPriceUsd, usdValueOf } from "../chain/prices";
import { createRpcPool, fromRaw, toRaw } from "../chain/rpc-pool";
import { useSlippage } from "../chain/slippage";
import { TokenIcon } from "./TokenIcon";
import {
  buildArbTxData,
  discoverArbVenue,
  fetchAndPreview,
  type ArbDirection,
  type ArbPreview,
} from "../chain/arb/desnetArb";
import { useAddress } from "../wallet/useConnect";
import { PACKAGE } from "../config";

const rpc = createRpcPool("desnet-arb");

const APT = TOKENS.APT;

export function DesnetArbPanel() {
  const { signAndSubmitTransaction, connected } = useWallet();
  const address = useAddress();
  const aptPrice = useAptPriceUsd();
  const [slippage] = useSlippage();
  const balApt = useFaBalance(APT.meta, APT.decimals);

  // Inputs
  const [desnetHandle, setDesnetHandle] = useState("");
  // Pool addr is split into auto-discovered + manual override. Effective
  // pool addr below the inputs prefers manual when non-empty, else auto.
  const [autoPoolAddr, setAutoPoolAddr] = useState<string | null>(null);
  const [autoTokenMeta, setAutoTokenMeta] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryErr, setDiscoveryErr] = useState<string | null>(null);
  const [manualPoolOverride, setManualPoolOverride] = useState("");
  const [aptInInput, setAptInInput] = useState("");
  const [minProfitInput, setMinProfitInput] = useState("");

  // Preview state
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<{
    best: ArbPreview;
    both: { desnet_first: ArbPreview; darbitex_first: ArbPreview };
    tokenMetaAddr: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Submit state
  const [submitting, setSubmitting] = useState(false);
  const [lastTx, setLastTx] = useState<string | null>(null);

  // Resolved token icon — pulls from bundled whitelist (DESNET, DARBITEX, …)
  // and falls back to on-chain Metadata.icon_uri. Empty addr returns a "?"
  // letter badge cleanly via TokenIcon's built-in fallback.
  const tokenView = useTokenView(autoTokenMeta);

  // Convert input to raw octa
  const aptInRaw: bigint | null = useMemo(() => {
    const n = Number(aptInInput);
    if (!Number.isFinite(n) || n <= 0) return null;
    return toRaw(n, APT.decimals);
  }, [aptInInput]);

  // Effective Darbitex pool addr — manual override wins when present and
  // syntactically valid; otherwise the auto-discovered addr.
  const effectivePoolAddr: string | null = useMemo(() => {
    const m = manualPoolOverride.trim();
    if (m && /^0x[0-9a-fA-F]{1,64}$/.test(m)) return m;
    return autoPoolAddr;
  }, [manualPoolOverride, autoPoolAddr]);

  // Auto-discover Darbitex pool whenever handle changes (debounced by
  // input cadence). Cancellation guard prevents stale resolution from
  // overwriting newer discovery results.
  useEffect(() => {
    let cancelled = false;
    const handle = desnetHandle.trim().replace(/^\$/, "").toLowerCase();
    setAutoPoolAddr(null);
    setAutoTokenMeta(null);
    setDiscoveryErr(null);
    if (!handle) return;
    setDiscovering(true);
    discoverArbVenue(rpc, handle, PACKAGE)
      .then((res) => {
        if (cancelled) return;
        if (!res) {
          setDiscoveryErr(
            `No Darbitex APT pool found for $${handle}. Either the handle isn't registered, the factory token has no APT pair on Darbitex, or you can paste a custom pool addr below.`,
          );
          return;
        }
        setAutoPoolAddr(res.darbitexPoolAddr);
        setAutoTokenMeta(res.tokenMetaAddr);
      })
      .catch((e) => {
        if (!cancelled) setDiscoveryErr((e as Error).message ?? String(e));
      })
      .finally(() => {
        if (!cancelled) setDiscovering(false);
      });
    return () => { cancelled = true; };
  }, [desnetHandle]);

  // Reset preview when key inputs change
  useEffect(() => {
    setPreview(null);
    setError(null);
    setLastTx(null);
  }, [desnetHandle, manualPoolOverride, aptInInput]);

  async function scan() {
    setError(null);
    setPreview(null);
    if (!desnetHandle.trim() || !effectivePoolAddr || aptInRaw === null) {
      setError(
        !effectivePoolAddr
          ? "No Darbitex pool resolved for this handle. Wait for auto-discovery, or paste a custom pool addr."
          : "Need DeSNet handle and a positive APT amount.",
      );
      return;
    }
    setPreviewing(true);
    try {
      const r = await fetchAndPreview(
        rpc,
        desnetHandle.trim().replace(/^\$/, "").toLowerCase(),
        effectivePoolAddr,
        PACKAGE,
        aptInRaw,
        Math.round(slippage * 10000),
      );
      setPreview(r);
      // Default min_profit = 0.5% of best.profit if positive, else 0
      if (r.preview.best.profit > 0n) {
        const defaultMin = (r.preview.best.profit * 99n) / 100n;
        setMinProfitInput(fromRaw(defaultMin, APT.decimals).toString());
      } else {
        setMinProfitInput("0");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  }

  const minProfitRaw: bigint | null = useMemo(() => {
    const n = Number(minProfitInput);
    if (!Number.isFinite(n) || n < 0) return null;
    return toRaw(n, APT.decimals);
  }, [minProfitInput]);

  const profitable = preview !== null && preview.preview.best.profit > 0n;
  const sufficientBalance =
    aptInRaw !== null && balApt.balance !== null && balApt.balance >= aptInRaw;
  const canSubmit =
    connected &&
    !!address &&
    profitable &&
    sufficientBalance &&
    minProfitRaw !== null &&
    !submitting;

  async function submit() {
    if (!preview || aptInRaw === null || minProfitRaw === null) return;
    setError(null);
    setLastTx(null);
    setSubmitting(true);
    if (!effectivePoolAddr) {
      setError("Pool addr disappeared between preview and submit. Re-scan.");
      setSubmitting(false);
      return;
    }
    try {
      const data = await buildArbTxData({
        desnetHandle: desnetHandle.trim().replace(/^\$/, "").toLowerCase(),
        darbitexPoolAddr: effectivePoolAddr,
        tokenMetaAddr: preview.tokenMetaAddr,
        aptIn: aptInRaw,
        minTokenMid: preview.preview.best.minTokenMid,
        minAptOut: preview.preview.best.minAptOut,
        minProfit: minProfitRaw,
        desnetFirst: preview.preview.best.direction === "desnet_first",
      });
      const result = await signAndSubmitTransaction({ data });
      setLastTx(result.hash);
    } catch (e) {
      setError(decodeArbError(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="card">
      <h3>Cross-DEX Arb (DeSNet ↔ Darbitex)</h3>
      <p className="muted small">
        Atomic 2-leg arb via a precompiled Move script. <strong>You pay upfront</strong>{" "}
        — no flash loan. Both legs revert together if final profit &lt; min_profit.
        100% of profit returns to your wallet (no protocol cut).
      </p>

      <label className="field">
        <span>DeSNet handle (e.g. <code>desnet</code>, <code>darbitex</code>)</span>
        <input
          value={desnetHandle}
          onChange={(e) => setDesnetHandle(e.target.value)}
          placeholder="desnet"
        />
      </label>

      <div className="field">
        <span>Darbitex APT pool (auto-discovered)</span>
        {discovering && <p className="muted small">Looking up canonical pool…</p>}
        {!discovering && autoPoolAddr && (
          <p className="ok small" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            ✓
            <span className="mono">{shortAddr(autoPoolAddr)}</span>
            {autoTokenMeta && (
              <span className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                · token <TokenIcon token={tokenView} size={16} /> {tokenView.symbol}
              </span>
            )}
            <a
              href={`https://explorer.aptoslabs.com/object/${autoPoolAddr}?network=mainnet`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ marginLeft: 8 }}
            >
              explorer →
            </a>
          </p>
        )}
        {!discovering && !autoPoolAddr && discoveryErr && (
          <p className="error small">{discoveryErr}</p>
        )}
        <details style={{ marginTop: 4 }}>
          <summary className="muted small" style={{ cursor: "pointer" }}>
            override pool addr (advanced)
          </summary>
          <input
            value={manualPoolOverride}
            onChange={(e) => setManualPoolOverride(e.target.value)}
            placeholder="0x… (overrides auto-discovery if non-empty)"
            style={{ marginTop: 6, width: "100%" }}
          />
          {manualPoolOverride.trim() && (
            <small className={/^0x[0-9a-fA-F]{1,64}$/.test(manualPoolOverride.trim()) ? "ok" : "error"}>
              {/^0x[0-9a-fA-F]{1,64}$/.test(manualPoolOverride.trim())
                ? "✓ valid format — using override"
                : "✗ not a 0x-prefixed hex addr — falling back to auto"}
            </small>
          )}
          <small className="muted">
            Use only if auto-discovery picked the wrong pool, or you want to
            arb against a non-canonical APT pool. Pool's $TOKEN side must
            match the handle's factory token, or the swap aborts.
          </small>
        </details>
      </div>

      <label className="field">
        <span>APT to commit (capital floor)</span>
        <input
          type="number"
          min="0"
          step="any"
          value={aptInInput}
          onChange={(e) => setAptInInput(e.target.value)}
          placeholder="0.0"
        />
        <small className="muted">
          Wallet APT balance:{" "}
          {balApt.balance !== null
            ? fromRaw(balApt.balance, APT.decimals).toString()
            : "…"}{" "}
          {aptInRaw !== null && balApt.balance !== null && balApt.balance < aptInRaw && (
            <span className="error"> — insufficient.</span>
          )}
        </small>
      </label>

      <button
        className="primary"
        onClick={scan}
        disabled={previewing || !aptInRaw || !desnetHandle.trim() || !darbitexPoolAddr.trim()}
      >
        {previewing ? "Scanning…" : "Preview cycle"}
      </button>

      {preview && (
        <div className="card-stat" style={{ marginTop: 12, padding: 8, background: "#0a0a0a" }}>
          <h4 style={{ margin: 0 }}>Preview</h4>
          <table className="about-table" style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th>Direction</th>
                <th>Mid (TOKEN out)</th>
                <th>Final (APT out)</th>
                <th>Profit (APT)</th>
              </tr>
            </thead>
            <tbody>
              {(["desnet_first", "darbitex_first"] as ArbDirection[]).map((d) => {
                const p = preview.preview.both[d];
                const isBest = preview.preview.best.direction === d;
                return (
                  <tr key={d} className={isBest ? "ok" : ""}>
                    <td>
                      <strong>{d === "desnet_first" ? "DeSNet → Darbitex" : "Darbitex → DeSNet"}</strong>
                      {isBest && <span className="ok"> ★</span>}
                    </td>
                    <td className="mono">{p.midOut.toString()}</td>
                    <td className="mono">{p.finalOut.toString()}</td>
                    <td className={p.profit > 0n ? "ok mono" : "error mono"}>
                      {p.profit >= 0n ? "+" : ""}{fromRaw(p.profit, APT.decimals).toString()}
                      {aptPrice && (
                        <span className="muted small">
                          {" "}({formatUsd(usdValueOf(p.profit, APT.decimals, aptPrice))})
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted small" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            Token: <TokenIcon token={tokenView} size={14} />{" "}
            <strong>{tokenView.symbol}</strong>{" "}
            <code>{shortAddr(preview.tokenMetaAddr)}</code>
            {" "}· Slippage: {(slippage * 100).toFixed(2)}% (recommended min_token_mid +
            min_apt_out already applied to chosen direction)
          </p>
        </div>
      )}

      {preview && profitable && (
        <label className="field" style={{ marginTop: 12 }}>
          <span>Min net profit (APT) — abort if final profit below this</span>
          <input
            type="number"
            min="0"
            step="any"
            value={minProfitInput}
            onChange={(e) => setMinProfitInput(e.target.value)}
            placeholder="0.0"
          />
        </label>
      )}

      {preview && !profitable && (
        <p className="error small" style={{ marginTop: 8 }}>
          No profitable direction at this size. Try a different amount or pool.
        </p>
      )}

      <button
        className="primary"
        disabled={!canSubmit}
        onClick={submit}
        style={{ marginTop: 12 }}
      >
        {submitting ? "Submitting…" : "Execute arb"}
      </button>

      {lastTx && (
        <p className="ok" style={{ marginTop: 8 }}>
          Done.{" "}
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
    </div>
  );
}

function shortAddr(a: string): string {
  return `${a.slice(0, 8)}…${a.slice(-4)}`;
}

function decodeArbError(err: unknown): string {
  const msg = (err as { message?: string })?.message ?? String(err);
  if (/User rejected|denied|cancel/i.test(msg)) return "Cancelled in wallet.";
  // Script local abort codes (E_NEGATIVE_PROFIT=200, E_BELOW_MIN_PROFIT=201)
  if (/abort.*200/i.test(msg)) return "Arb produced negative profit at execution time. Pool moved.";
  if (/abort.*201/i.test(msg)) return "Arb profitable but below your min_profit floor.";
  // Slippage on individual legs
  if (/E_SLIPPAGE_EXCEEDED|min_out/i.test(msg)) return "Per-leg slippage exceeded. Pool reserves moved between preview and submit.";
  if (/EINSUFFICIENT_BALANCE|coin store empty/i.test(msg)) return "Insufficient APT for the script + gas.";
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}
