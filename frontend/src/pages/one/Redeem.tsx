import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ONE_PACKAGE, ONE_PARAMS, TOKENS } from "../../config";
import { useFaBalance } from "../../chain/balance";
import { onePrice8dec, oneReserveBalance } from "../../chain/one";
import { decodeOneError } from "../../chain/oneErrors";
import { formatApt, formatAptUsd, formatOne } from "../../chain/oneFormat";
import { fetchAptUsdVaa } from "../../chain/pyth";
import { createRpcPool, toRaw } from "../../chain/rpc-pool";
import { useAddress } from "../../wallet/useConnect";

const rpc = createRpcPool("one-redeem");

type Mode = "target" | "reserve";

export function OneRedeem() {
  const { signAndSubmitTransaction } = useWallet();
  const address = useAddress();
  const one = TOKENS.ONE;
  const apt = TOKENS.APT;
  const oneBal = useFaBalance(one.meta, one.decimals);
  const aptBal = useFaBalance(apt.meta, apt.decimals);

  const [priceRaw, setPriceRaw] = useState<bigint | null>(null);
  const [reserveRaw, setReserveRaw] = useState<bigint | null>(null);
  const [priceAgeSecs, setPriceAgeSecs] = useState<number>(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const [mode, setMode] = useState<Mode>("reserve");
  const [oneAmt, setOneAmt] = useState("");
  const [target, setTarget] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, r] = await Promise.all([onePrice8dec(rpc), oneReserveBalance(rpc)]);
        if (!cancelled) {
          setPriceRaw(p);
          setReserveRaw(r);
          setPriceAgeSecs(0);
        }
      } catch (e) {
        if (!cancelled) setError(decodeOneError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    if (priceRaw === null) return;
    const t = setInterval(() => setPriceAgeSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [priceRaw, refreshKey]);

  const projected = useMemo(() => {
    if (priceRaw === null) return null;
    const n = Number(oneAmt);
    if (!Number.isFinite(n) || n <= 0) return null;
    const oneRaw = toRaw(n, ONE_PARAMS.ONE_DECIMALS);
    const feeRaw = (oneRaw * BigInt(ONE_PARAMS.FEE_BPS)) / 10_000n;
    const netRaw = oneRaw - feeRaw;
    const collOut = (netRaw * 100_000_000n) / priceRaw;
    return { oneRaw, feeRaw, netRaw, collOut };
  }, [oneAmt, priceRaw]);

  const targetValid =
    mode === "reserve" ||
    (target.startsWith("0x") && target.length >= 60 && target.length <= 66);

  const stale = priceAgeSecs > ONE_PARAMS.STALENESS_SECS;

  async function submit() {
    if (!address || !projected) return;
    setSubmitting(true);
    setError(null);
    setLastTx(null);
    try {
      const vaa = await fetchAptUsdVaa();
      const fn =
        mode === "reserve" ? "redeem_from_reserve_pyth" : "redeem_pyth";
      const args =
        mode === "reserve"
          ? [projected.oneRaw.toString(), vaa]
          : [projected.oneRaw.toString(), target, vaa];

      const result = await signAndSubmitTransaction({
        data: {
          function: `${ONE_PACKAGE}::ONE::${fn}`,
          typeArguments: [],
          functionArguments: args,
        },
      });
      setLastTx(result.hash);
      setOneAmt("");
      oneBal.refresh();
      aptBal.refresh();
      refresh();
    } catch (e) {
      setError(decodeOneError(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (!address) {
    return <p className="page-sub">Connect your wallet to redeem ONE for APT.</p>;
  }

  return (
    <>
      <p className="page-sub">
        Burn ONE for APT at the live Pyth price. 1% fee, 150% hard cap preserved for
        targeted troves. Reserve path redeems against protocol-owned collateral.
      </p>

      <section className="protocol-grid">
        <div className="protocol-card small">
          <div className="protocol-label">APT / USD (Pyth)</div>
          <div className="protocol-big">
            {priceRaw === null ? "—" : formatAptUsd(priceRaw)}
          </div>
          <div className="protocol-note">
            age ~{priceAgeSecs}s {stale && "· stale"}
          </div>
        </div>
        <div className="protocol-card small">
          <div className="protocol-label">Protocol reserve</div>
          <div className="protocol-big">
            {reserveRaw === null ? "—" : formatApt(reserveRaw)}
          </div>
          <div className="protocol-note">APT available for reserve-redeem</div>
        </div>
        <div className="protocol-card small">
          <div className="protocol-label">Your ONE balance</div>
          <div className="protocol-big">
            {oneBal.loading ? "…" : oneBal.formatted.toFixed(4)}
          </div>
          <div className="protocol-note">ONE</div>
        </div>
      </section>

      <div className="subnav" style={{ marginTop: 12 }}>
        <a
          href="#"
          className={mode === "reserve" ? "active" : ""}
          onClick={(e) => {
            e.preventDefault();
            setMode("reserve");
          }}
        >
          Reserve redeem
        </a>
        <a
          href="#"
          className={mode === "target" ? "active" : ""}
          onClick={(e) => {
            e.preventDefault();
            setMode("target");
          }}
        >
          Targeted redeem
        </a>
      </div>

      {mode === "target" && (
        <div className="err" style={{ marginBottom: 12 }}>
          <strong>Warning:</strong> targeted redemption pulls collateral from the
          specified trove owner. R4-M-01 disclosure — cached Pyth price (≤
          {ONE_PARAMS.STALENESS_SECS}s stale) can let alert callers extract surplus
          when APT moves &gt; 1% in-window. Refresh the oracle immediately before
          submit.
        </div>
      )}

      <div className="card" style={{ padding: 16 }}>
        <div className="swap-row">
          <label>ONE to burn</label>
          <div className="swap-input">
            <input
              type="number"
              placeholder={`≥ ${Number(ONE_PARAMS.MIN_DEBT_RAW) / 10 ** ONE_PARAMS.ONE_DECIMALS}`}
              min="0"
              value={oneAmt}
              onChange={(e) => setOneAmt(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="bal-link"
            onClick={() => setOneAmt(String(oneBal.formatted))}
            disabled={oneBal.raw === 0n}
          >
            Max: {oneBal.loading ? "…" : oneBal.formatted.toFixed(4)}
          </button>
        </div>

        {mode === "target" && (
          <div className="swap-row">
            <label>Target trove address</label>
            <div className="swap-input">
              <input
                type="text"
                placeholder="0x…"
                value={target}
                onChange={(e) => setTarget(e.target.value.trim())}
              />
            </div>
          </div>
        )}

        {projected && (
          <div className="hint">
            You will receive ≈ {formatApt(projected.collOut, 6)} APT (net of 1% fee{" "}
            = {formatOne(projected.feeRaw, 6)} ONE).
          </div>
        )}

        <button
          type="button"
          className="btn btn-secondary"
          onClick={refresh}
          disabled={submitting}
          style={{ marginBottom: 8 }}
        >
          Refresh price snapshot
        </button>

        {error && <div className="err">{error}</div>}
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

        <button
          type="button"
          className="primary"
          disabled={!projected || !targetValid || submitting}
          onClick={submit}
        >
          {submitting
            ? "Submitting…"
            : mode === "reserve"
              ? "Redeem from reserve"
              : "Redeem against target"}
        </button>
      </div>
    </>
  );
}
