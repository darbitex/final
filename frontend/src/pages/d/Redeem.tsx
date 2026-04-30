import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { D_PACKAGE, D_PARAMS, TOKENS } from "../../config";
import { useFaBalance } from "../../chain/balance";
import { dPrice8dec, dReserveBalance, dTroveHealth } from "../../chain/d";
import { decodeDError } from "../../chain/dErrors";
import { formatApt, formatAptUsd, formatCrBps, formatD } from "../../chain/dFormat";
import { fetchAptUsdVaa } from "../../chain/pyth";
import { createRpcPool, toRaw } from "../../chain/rpc-pool";
import { useAddress } from "../../wallet/useConnect";

const rpc = createRpcPool("d-redeem");

type Mode = "target" | "reserve";

type TroveCandidate = {
  address: string;
  collateral: bigint;
  debt: bigint;
  crBps: bigint;
};

// Mirror of the discovery scanner in Liquidate.tsx, minus the under-water
// filter — redeem has no health gate, so every active trove (debt > 0) is
// a valid target. Sorted by CR ascending because redeeming against the
// weakest trove first is the most peg-efficient call (same logic Liquity
// V1's sorted list enforces, but here it's caller-specified).
async function discoverActiveTroves(): Promise<TroveCandidate[]> {
  type UT = { sender: string; entry_function_id_str: string } | null;
  type Row = { user_transaction: UT };
  type Q = { account_transactions: Row[] };
  const openFns = new Set([
    `${D_PACKAGE}::D::open_trove`,
    `${D_PACKAGE}::D::open_trove_pyth`,
  ]);
  const query = {
    query: `query OpenTroveTxs($pkg: String!) {
      account_transactions(
        where: { account_address: { _eq: $pkg } }
        limit: 1000
        order_by: { transaction_version: desc }
      ) {
        user_transaction {
          sender
          entry_function_id_str
        }
      }
    }`,
    variables: { pkg: D_PACKAGE },
  };
  const res = await rpc.primary.queryIndexer<Q>({ query });
  const seen = new Set<string>();
  for (const row of res.account_transactions ?? []) {
    const ut = row.user_transaction;
    if (!ut) continue;
    if (!openFns.has(ut.entry_function_id_str)) continue;
    if (ut.sender) seen.add(ut.sender);
  }
  const results = await Promise.all(
    Array.from(seen).map(async (a) => {
      try {
        const h = await dTroveHealth(rpc, a);
        return { address: a, ...h };
      } catch {
        return null;
      }
    }),
  );
  return results
    .filter((r): r is TroveCandidate => r !== null && r.debt > 0n)
    .sort((a, b) => (a.crBps > b.crBps ? 1 : a.crBps < b.crBps ? -1 : 0));
}

export function DRedeem() {
  const { signAndSubmitTransaction } = useWallet();
  const address = useAddress();
  const d = TOKENS.D;
  const apt = TOKENS.APT;
  const dBal = useFaBalance(d.meta, d.decimals);
  const aptBal = useFaBalance(apt.meta, apt.decimals);

  const [priceRaw, setPriceRaw] = useState<bigint | null>(null);
  const [reserveRaw, setReserveRaw] = useState<bigint | null>(null);
  const [priceAgeSecs, setPriceAgeSecs] = useState<number>(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const [mode, setMode] = useState<Mode>("reserve");
  const [dAmt, setDAmt] = useState("");
  const [target, setTarget] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const [candidates, setCandidates] = useState<TroveCandidate[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  const refreshCandidates = useCallback(async () => {
    setDiscovering(true);
    setDiscoverError(null);
    try {
      setCandidates(await discoverActiveTroves());
    } catch (e) {
      setDiscoverError(decodeDError(e));
    } finally {
      setDiscovering(false);
    }
  }, []);

  useEffect(() => {
    if (mode === "target" && candidates.length === 0 && !discovering) {
      refreshCandidates();
    }
  }, [mode, candidates.length, discovering, refreshCandidates]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, r] = await Promise.all([dPrice8dec(rpc), dReserveBalance(rpc)]);
        if (!cancelled) {
          setPriceRaw(p);
          setReserveRaw(r);
          setPriceAgeSecs(0);
        }
      } catch (e) {
        if (!cancelled) setError(decodeDError(e));
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
    const n = Number(dAmt);
    if (!Number.isFinite(n) || n <= 0) return null;
    const dRaw = toRaw(n, D_PARAMS.D_DECIMALS);
    const feeRaw = (dRaw * BigInt(D_PARAMS.FEE_BPS)) / 10_000n;
    const netRaw = dRaw - feeRaw;
    const collOut = (netRaw * 100_000_000n) / priceRaw;
    return { dRaw, feeRaw, netRaw, collOut };
  }, [dAmt, priceRaw]);

  const targetValid =
    mode === "reserve" ||
    (target.startsWith("0x") && target.length >= 60 && target.length <= 66);

  const stale = priceAgeSecs > D_PARAMS.STALENESS_SECS;

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
          ? [projected.dRaw.toString(), vaa]
          : [projected.dRaw.toString(), target, vaa];

      const result = await signAndSubmitTransaction({
        data: {
          function: `${D_PACKAGE}::D::${fn}`,
          typeArguments: [],
          functionArguments: args,
        },
      });
      setLastTx(result.hash);
      setDAmt("");
      dBal.refresh();
      aptBal.refresh();
      refresh();
    } catch (e) {
      setError(decodeDError(e));
    } finally {
      setSubmitting(false);
    }
  }

  if (!address) {
    return <p className="page-sub">Connect your wallet to redeem D for APT.</p>;
  }

  return (
    <>
      <p className="page-sub">
        Burn D for APT at the live Pyth price. 1% fee, 150% hard cap preserved for
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
          <div className="protocol-label">Your D balance</div>
          <div className="protocol-big">
            {dBal.loading ? "…" : dBal.formatted.toFixed(4)}
          </div>
          <div className="protocol-note">D</div>
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
        <>
          <div className="err" style={{ marginBottom: 12 }}>
            <strong>Warning:</strong> targeted redemption pulls collateral from the
            specified trove owner. R4-M-01 disclosure — cached Pyth price (≤
            {D_PARAMS.STALENESS_SECS}s stale) can let alert callers extract surplus
            when APT moves &gt; 1% in-window. Refresh the oracle immediately before
            submit.
          </div>

          <div className="card" style={{ padding: 16, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <h2 className="section-title" style={{ margin: 0 }}>
                Active troves
              </h2>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={refreshCandidates}
                disabled={discovering}
              >
                {discovering ? "Scanning…" : "Refresh"}
              </button>
            </div>
            <div style={{ fontSize: 11, color: "#777", marginBottom: 8 }}>
              Sorted by CR (lowest first). Redeeming against the weakest trove is
              the most peg-efficient call. Discovered via{" "}
              <code>account_transactions</code> → <code>open_trove*</code> senders.
            </div>

            {discoverError && <div className="err">{discoverError}</div>}
            {!discovering && candidates.length === 0 && !discoverError && (
              <div className="hint">No active troves found.</div>
            )}
            {discovering && candidates.length === 0 && (
              <div className="hint">Scanning open-trove txns…</div>
            )}

            {candidates.length > 0 && (
              <div
                style={{
                  maxHeight: 260,
                  overflowY: "auto",
                  border: "1px solid #1a1a1a",
                  borderRadius: 6,
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "2fr 1fr 1fr 1fr",
                    gap: 6,
                    padding: "6px 10px",
                    fontSize: 11,
                    color: "#666",
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    borderBottom: "1px solid #1a1a1a",
                  }}
                >
                  <span>Trove owner</span>
                  <span>CR</span>
                  <span>Debt (D)</span>
                  <span>Coll (APT)</span>
                </div>
                {candidates.map((t) => {
                  const isSelected = target.toLowerCase() === t.address.toLowerCase();
                  const riskColor =
                    t.crBps < BigInt(D_PARAMS.LIQ_THRESHOLD_BPS)
                      ? "#ff6b6b"
                      : t.crBps < BigInt(D_PARAMS.MCR_BPS)
                        ? "#ff8800"
                        : "#b0b0b0";
                  return (
                    <button
                      key={t.address}
                      type="button"
                      onClick={() => setTarget(t.address)}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "2fr 1fr 1fr 1fr",
                        gap: 6,
                        padding: "8px 10px",
                        fontSize: 12,
                        width: "100%",
                        textAlign: "left",
                        background: isSelected ? "#181818" : "transparent",
                        color: "#e0e0e0",
                        border: "none",
                        borderBottom: "1px solid #111",
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "monospace",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={t.address}
                      >
                        {t.address.slice(0, 10)}…{t.address.slice(-6)}
                      </span>
                      <span style={{ color: riskColor, fontWeight: 600 }}>
                        {formatCrBps(t.crBps)}
                      </span>
                      <span>{formatD(t.debt)}</span>
                      <span>{formatApt(t.collateral)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      <div className="card" style={{ padding: 16 }}>
        <div className="swap-row">
          <label>D to burn</label>
          <div className="swap-input">
            <input
              type="number"
              placeholder={`≥ ${Number(D_PARAMS.MIN_DEBT_RAW) / 10 ** D_PARAMS.D_DECIMALS}`}
              min="0"
              value={dAmt}
              onChange={(e) => setDAmt(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="bal-link"
            onClick={() => setDAmt(String(dBal.formatted))}
            disabled={dBal.raw === 0n}
          >
            Max: {dBal.loading ? "…" : dBal.formatted.toFixed(4)}
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
            = {formatD(projected.feeRaw, 6)} D).
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
