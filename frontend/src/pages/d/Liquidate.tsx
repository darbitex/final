import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useCallback, useEffect, useState } from "react";
import { D_PACKAGE, D_PARAMS } from "../../config";
import { dPrice8dec, dTroveHealth } from "../../chain/d";
import { decodeDError } from "../../chain/dErrors";
import { formatApt, formatAptUsd, formatCrBps, formatD } from "../../chain/dFormat";
import { fetchAptUsdVaa } from "../../chain/pyth";
import { createRpcPool } from "../../chain/rpc-pool";
import { useAddress } from "../../wallet/useConnect";

const rpc = createRpcPool("d-liquidate");

type Health = {
  collateral: bigint;
  debt: bigint;
  crBps: bigint;
  priceRaw: bigint;
};

type DiscoveredTrove = {
  address: string;
  collateral: bigint;
  debt: bigint;
  crBps: bigint;
};

// Discover potentially-liquidatable troves without the deprecated events
// table. Strategy: account_transactions (indexed by account_address) gives
// every tx that touched D_PACKAGE; JOIN user_transaction exposes the
// signer + entry function. We filter client-side for open_trove* calls,
// dedupe senders, then probe trove_health for each in parallel. Troves
// that are closed or redeemed to zero surface as debt=0 and get dropped.
async function discoverLiquidatableTroves(
  liqThresholdBps: bigint,
): Promise<{ liquidatable: DiscoveredTrove[]; healthyCount: number; scanned: number }> {
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

  const addrs = Array.from(seen);
  const results = await Promise.all(
    addrs.map(async (a) => {
      try {
        const h = await dTroveHealth(rpc, a);
        return { address: a, ...h };
      } catch {
        return null;
      }
    }),
  );
  const active = results.filter(
    (r): r is DiscoveredTrove => r !== null && r.debt > 0n,
  );
  const liquidatable = active
    .filter((r) => r.crBps < liqThresholdBps)
    .sort((a, b) => (a.crBps > b.crBps ? 1 : a.crBps < b.crBps ? -1 : 0));
  return {
    liquidatable,
    healthyCount: active.length - liquidatable.length,
    scanned: active.length,
  };
}

export function DLiquidate() {
  const { signAndSubmitTransaction } = useWallet();
  const address = useAddress();
  const [target, setTarget] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [checking, setChecking] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  // Auto-discovery state
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoveredTrove[]>([]);
  const [scanStats, setScanStats] = useState<{ healthyCount: number; scanned: number } | null>(
    null,
  );
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [priceRaw, setPriceRaw] = useState<bigint | null>(null);

  const refreshDiscovery = useCallback(async () => {
    setDiscovering(true);
    setDiscoverError(null);
    try {
      // Fresh price for the payout estimate in the list; trove_health in
      // discoverLiquidatableTroves already uses the cached on-chain price.
      const [scan, p] = await Promise.all([
        discoverLiquidatableTroves(BigInt(D_PARAMS.LIQ_THRESHOLD_BPS)),
        dPrice8dec(rpc),
      ]);
      setDiscovered(scan.liquidatable);
      setScanStats({ healthyCount: scan.healthyCount, scanned: scan.scanned });
      setPriceRaw(p);
    } catch (e) {
      setDiscoverError(decodeDError(e));
    } finally {
      setDiscovering(false);
    }
  }, []);

  useEffect(() => {
    refreshDiscovery();
  }, [refreshDiscovery]);

  const targetValid =
    target.startsWith("0x") && target.length >= 60 && target.length <= 66;

  const check = useCallback(async () => {
    if (!targetValid) return;
    setChecking(true);
    setError(null);
    setHealth(null);
    try {
      const [h, p] = await Promise.all([
        dTroveHealth(rpc, target),
        dPrice8dec(rpc),
      ]);
      setHealth({ ...h, priceRaw: p });
    } catch (e) {
      setError(decodeDError(e));
    } finally {
      setChecking(false);
    }
  }, [target, targetValid]);

  function pickFromList(t: DiscoveredTrove) {
    setTarget(t.address);
    setHealth({
      collateral: t.collateral,
      debt: t.debt,
      crBps: t.crBps,
      priceRaw: priceRaw ?? 0n,
    });
    setError(null);
  }

  async function submit() {
    if (!address || !targetValid) return;
    setSubmitting(true);
    setError(null);
    setLastTx(null);
    try {
      const vaa = await fetchAptUsdVaa();
      const result = await signAndSubmitTransaction({
        data: {
          function: `${D_PACKAGE}::D::liquidate_pyth`,
          typeArguments: [],
          functionArguments: [target, vaa],
        },
      });
      setLastTx(result.hash);
      check();
      refreshDiscovery();
    } catch (e) {
      setError(decodeDError(e));
    } finally {
      setSubmitting(false);
    }
  }

  const liquidatable =
    health !== null &&
    health.debt > 0n &&
    health.crBps < BigInt(D_PARAMS.LIQ_THRESHOLD_BPS);

  const liquidatorApt = (() => {
    if (!health || !liquidatable || health.priceRaw === 0n) return 0n;
    const bonusUsd =
      (health.debt * BigInt(D_PARAMS.LIQ_BONUS_BPS)) / 10_000n;
    const liqShareUsd =
      (bonusUsd * BigInt(D_PARAMS.LIQ_LIQUIDATOR_BPS)) / 10_000n;
    return (liqShareUsd * 100_000_000n) / health.priceRaw;
  })();

  function payoutFor(t: DiscoveredTrove): bigint {
    if (priceRaw === null || priceRaw === 0n) return 0n;
    const bonusUsd = (t.debt * BigInt(D_PARAMS.LIQ_BONUS_BPS)) / 10_000n;
    const liqShareUsd = (bonusUsd * BigInt(D_PARAMS.LIQ_LIQUIDATOR_BPS)) / 10_000n;
    return (liqShareUsd * 100_000_000n) / priceRaw;
  }

  if (!address) {
    return <p className="page-sub">Connect your wallet to liquidate an under-collateralized trove.</p>;
  }

  return (
    <>
      <p className="page-sub">
        Permissionless liquidation. We scan recent txns touching the D
        package via <code>account_transactions</code>, filter for{" "}
        <code>open_trove</code> / <code>open_trove_pyth</code> calls, probe{" "}
        <code>trove_health</code> for each signer, and list whoever sits below{" "}
        {D_PARAMS.LIQ_THRESHOLD_BPS / 100}% CR. Click a row to auto-fill the
        target, or paste an address manually. The stability pool absorbs the
        debt; the {D_PARAMS.LIQ_BONUS_BPS / 100}% bonus on debt splits{" "}
        {D_PARAMS.LIQ_LIQUIDATOR_BPS / 100}% to you /{" "}
        {D_PARAMS.LIQ_SP_RESERVE_BPS / 100}% to reserve / remainder to the
        SP collateral pool.
      </p>

      {/* ===== Auto-discovered list ===== */}
      <div className="card" style={{ padding: 16, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <h2 className="section-title" style={{ margin: 0 }}>
            Under-water troves
          </h2>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={refreshDiscovery}
            disabled={discovering}
          >
            {discovering ? "Scanning…" : "Refresh"}
          </button>
        </div>

        {discoverError && <div className="err">{discoverError}</div>}

        {!discovering && discovered.length === 0 && !discoverError && (
          <div className="hint">
            No under-water troves right now.
            {scanStats && (
              <>
                {" "}Scanned {scanStats.scanned} active trove
                {scanStats.scanned === 1 ? "" : "s"} ·{" "}
                {scanStats.healthyCount} healthy.
              </>
            )}
          </div>
        )}

        {discovering && discovered.length === 0 && (
          <div className="hint">Scanning open troves via indexer…</div>
        )}

        {discovered.length > 0 && (
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
              <span>Payout (APT)</span>
            </div>
            {discovered.map((t) => (
              <button
                key={t.address}
                type="button"
                onClick={() => pickFromList(t)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "2fr 1fr 1fr 1fr",
                  gap: 6,
                  padding: "8px 10px",
                  fontSize: 12,
                  width: "100%",
                  textAlign: "left",
                  background: target === t.address ? "#181818" : "transparent",
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
                <span style={{ color: "#ff6b6b", fontWeight: 600 }}>
                  {formatCrBps(t.crBps)}
                </span>
                <span>{formatD(t.debt)}</span>
                <span style={{ color: "#6eff8e" }}>
                  {formatApt(payoutFor(t), 6)}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ===== Manual entry + check + submit ===== */}
      <div className="card" style={{ padding: 16 }}>
        <div className="swap-row">
          <label>Target trove</label>
          <div className="swap-input">
            <input
              type="text"
              placeholder="0x… (auto-filled when you click a row above)"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value.trim());
                setHealth(null);
              }}
            />
          </div>
        </div>

        <button
          type="button"
          className="btn btn-secondary"
          onClick={check}
          disabled={!targetValid || checking}
          style={{ marginBottom: 8 }}
        >
          {checking ? "Checking…" : "Check trove health"}
        </button>

        {health && (
          <section className="protocol-grid" style={{ marginBottom: 12 }}>
            <div className="protocol-card small">
              <div className="protocol-label">Collateral</div>
              <div className="protocol-big">{formatApt(health.collateral)}</div>
              <div className="protocol-note">APT</div>
            </div>
            <div className="protocol-card small">
              <div className="protocol-label">Debt</div>
              <div className="protocol-big">{formatD(health.debt)}</div>
              <div className="protocol-note">D</div>
            </div>
            <div className="protocol-card small">
              <div className="protocol-label">CR</div>
              <div
                className="protocol-big"
                style={{
                  color:
                    health.debt === 0n
                      ? "#888"
                      : liquidatable
                        ? "#ff6b6b"
                        : "#6eff8e",
                }}
              >
                {formatCrBps(health.crBps)}
              </div>
              <div className="protocol-note">
                liq &lt; {D_PARAMS.LIQ_THRESHOLD_BPS / 100}%
              </div>
            </div>
            <div className="protocol-card small">
              <div className="protocol-label">APT / USD (Pyth)</div>
              <div className="protocol-big">
                {health.priceRaw === 0n ? "—" : formatAptUsd(health.priceRaw)}
              </div>
              <div className="protocol-note">refreshes inside tx</div>
            </div>
          </section>
        )}

        {health && !liquidatable && health.debt > 0n && (
          <div className="hint">
            Trove is healthy (CR ≥ {D_PARAMS.LIQ_THRESHOLD_BPS / 100}%). Cannot
            liquidate until the APT price drops or CR degrades.
          </div>
        )}
        {health && health.debt === 0n && (
          <div className="hint">No active trove at this address.</div>
        )}

        {liquidatable && (
          <div className="ok" style={{ marginBottom: 8 }}>
            Liquidatable. Your payout ≈ {formatApt(liquidatorApt, 6)} APT (
            {D_PARAMS.LIQ_LIQUIDATOR_BPS / 100}% of the{" "}
            {D_PARAMS.LIQ_BONUS_BPS / 100}% bonus on debt, converted at Pyth
            price).
          </div>
        )}

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
          disabled={!liquidatable || submitting}
          onClick={submit}
        >
          {submitting ? "Submitting…" : "Liquidate"}
        </button>
      </div>
    </>
  );
}
