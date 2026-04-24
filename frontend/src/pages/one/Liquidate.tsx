import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useState } from "react";
import { ONE_PACKAGE, ONE_PARAMS } from "../../config";
import { onePrice8dec, oneTroveHealth } from "../../chain/one";
import { decodeOneError } from "../../chain/oneErrors";
import { formatApt, formatAptUsd, formatCrBps, formatOne } from "../../chain/oneFormat";
import { fetchAptUsdVaa } from "../../chain/pyth";
import { createRpcPool } from "../../chain/rpc-pool";
import { useAddress } from "../../wallet/useConnect";

const rpc = createRpcPool("one-liquidate");

type Health = {
  collateral: bigint;
  debt: bigint;
  crBps: bigint;
  priceRaw: bigint;
};

export function OneLiquidate() {
  const { signAndSubmitTransaction } = useWallet();
  const address = useAddress();
  const [target, setTarget] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [checking, setChecking] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const targetValid =
    target.startsWith("0x") && target.length >= 60 && target.length <= 66;

  async function check() {
    if (!targetValid) return;
    setChecking(true);
    setError(null);
    setHealth(null);
    try {
      const [h, p] = await Promise.all([
        oneTroveHealth(rpc, target),
        onePrice8dec(rpc),
      ]);
      setHealth({ ...h, priceRaw: p });
    } catch (e) {
      setError(decodeOneError(e));
    } finally {
      setChecking(false);
    }
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
          function: `${ONE_PACKAGE}::ONE::liquidate_pyth`,
          typeArguments: [],
          functionArguments: [target, vaa],
        },
      });
      setLastTx(result.hash);
      check();
    } catch (e) {
      setError(decodeOneError(e));
    } finally {
      setSubmitting(false);
    }
  }

  const liquidatable =
    health !== null &&
    health.debt > 0n &&
    health.crBps < BigInt(ONE_PARAMS.LIQ_THRESHOLD_BPS);

  // Liquidator payout in APT. Formula mirrors liquidate() in ONE.move:
  //   bonus_usd      = debt * LIQ_BONUS_BPS / 10000           (8-dec USD)
  //   liq_share_usd  = bonus_usd * LIQ_LIQUIDATOR_BPS / 10000 (8-dec USD)
  //   liq_coll_apt   = liq_share_usd * 1e8 / price            (8-dec APT)
  const liquidatorApt = (() => {
    if (!health || !liquidatable) return 0n;
    const bonusUsd =
      (health.debt * BigInt(ONE_PARAMS.LIQ_BONUS_BPS)) / 10_000n;
    const liqShareUsd =
      (bonusUsd * BigInt(ONE_PARAMS.LIQ_LIQUIDATOR_BPS)) / 10_000n;
    return (liqShareUsd * 100_000_000n) / health.priceRaw;
  })();

  if (!address) {
    return <p className="page-sub">Connect your wallet to liquidate an under-collateralized trove.</p>;
  }

  return (
    <>
      <p className="page-sub">
        Permissionless liquidation. Paste a target trove owner, check health,
        and call <code>liquidate_pyth</code>. The stability pool absorbs the
        debt; the total {ONE_PARAMS.LIQ_BONUS_BPS / 100}% bonus on debt splits
        as {ONE_PARAMS.LIQ_LIQUIDATOR_BPS / 100}% to you (liquidator) +{" "}
        {ONE_PARAMS.LIQ_SP_RESERVE_BPS / 100}% to reserve + remainder to the
        SP collateral pool. Pyth oracle refreshes inside the tx.
      </p>

      <div className="card" style={{ padding: 16 }}>
        <div className="swap-row">
          <label>Target trove</label>
          <div className="swap-input">
            <input
              type="text"
              placeholder="0x…"
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
              <div className="protocol-big">{formatOne(health.debt)}</div>
              <div className="protocol-note">ONE</div>
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
                liq &lt; {ONE_PARAMS.LIQ_THRESHOLD_BPS / 100}%
              </div>
            </div>
            <div className="protocol-card small">
              <div className="protocol-label">APT / USD (Pyth)</div>
              <div className="protocol-big">{formatAptUsd(health.priceRaw)}</div>
              <div className="protocol-note">refreshes inside tx</div>
            </div>
          </section>
        )}

        {health && !liquidatable && health.debt > 0n && (
          <div className="hint">
            Trove is healthy (CR ≥ {ONE_PARAMS.LIQ_THRESHOLD_BPS / 100}%). Cannot
            liquidate until the APT price drops or CR degrades.
          </div>
        )}
        {health && health.debt === 0n && (
          <div className="hint">No active trove at this address.</div>
        )}

        {liquidatable && (
          <div className="ok" style={{ marginBottom: 8 }}>
            Liquidatable. Your payout ≈ {formatApt(liquidatorApt, 6)} APT (
            {ONE_PARAMS.LIQ_LIQUIDATOR_BPS / 100}% of the{" "}
            {ONE_PARAMS.LIQ_BONUS_BPS / 100}% bonus on debt, converted at Pyth
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
