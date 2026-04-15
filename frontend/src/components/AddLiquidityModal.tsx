import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useEffect, useState } from "react";
import { PACKAGE, TOKENS } from "../config";
import { useFaBalance } from "../chain/balance";
import { createRpcPool, fromRaw, toRaw } from "../chain/rpc-pool";
import { useSlippage } from "../chain/slippage";
import { Modal } from "./Modal";

export type AddTarget = {
  poolAddr: string;
  symbolA: string;
  symbolB: string;
};

// Dedicated pool-state reader. Isolated from per-page view pools so a
// balance + pool-state burst inside an open modal doesn't contend with
// a background quote on the Pools page.
const rpc = createRpcPool("add-liquidity");

type PoolState = {
  reserveA: bigint;
  reserveB: bigint;
  lpSupply: bigint;
};

type PoolResource = {
  reserve_a: string | number;
  reserve_b: string | number;
  lp_supply: string | number;
};

async function fetchPoolState(poolAddr: string): Promise<PoolState | null> {
  try {
    const res = await rpc.rotatedGetResource<{ data: PoolResource }>(
      poolAddr,
      `${PACKAGE}::pool::Pool`,
    );
    const data = res.data;
    return {
      reserveA: BigInt(String(data.reserve_a ?? "0")),
      reserveB: BigInt(String(data.reserve_b ?? "0")),
      lpSupply: BigInt(String(data.lp_supply ?? "0")),
    };
  } catch {
    return null;
  }
}

export function AddLiquidityModal({
  target,
  onClose,
  onDone,
}: {
  target: AddTarget | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { signAndSubmitTransaction, connected } = useWallet();
  const [slippage] = useSlippage();
  const [amtA, setAmtA] = useState("");
  const [amtB, setAmtB] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [pool, setPool] = useState<PoolState | null>(null);
  const [poolLoading, setPoolLoading] = useState(false);

  const tokA = target ? TOKENS[target.symbolA] : null;
  const tokB = target ? TOKENS[target.symbolB] : null;
  const decA = tokA?.decimals ?? 8;
  const decB = tokB?.decimals ?? 6;

  const balA = useFaBalance(tokA?.meta ?? null, decA);
  const balB = useFaBalance(tokB?.meta ?? null, decB);

  useEffect(() => {
    if (!target) {
      setPool(null);
      return;
    }
    let cancelled = false;
    setPoolLoading(true);
    fetchPoolState(target.poolAddr)
      .then((p) => {
        if (!cancelled) setPool(p);
      })
      .finally(() => {
        if (!cancelled) setPoolLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  if (!target || !tokA || !tokB) return null;

  const hasReserves = pool !== null && pool.reserveA > 0n && pool.reserveB > 0n;

  function onChangeA(val: string) {
    setAmtA(val);
    if (!hasReserves || !val || !pool) return;
    const a = Number.parseFloat(val);
    if (a > 0) {
      const rawA = toRaw(a, decA);
      const rawB = (rawA * pool.reserveB) / pool.reserveA;
      setAmtB(String(fromRaw(rawB, decB)));
    } else {
      setAmtB("");
    }
  }

  function onChangeB(val: string) {
    setAmtB(val);
    if (!hasReserves || !val || !pool) return;
    const b = Number.parseFloat(val);
    if (b > 0) {
      const rawB = toRaw(b, decB);
      const rawA = (rawB * pool.reserveA) / pool.reserveB;
      setAmtA(String(fromRaw(rawA, decA)));
    } else {
      setAmtA("");
    }
  }

  function setMaxA() {
    if (balA.raw === 0n) return;
    onChangeA(String(balA.formatted));
  }

  function setMaxB() {
    if (balB.raw === 0n) return;
    onChangeB(String(balB.formatted));
  }

  async function submit() {
    if (!target || !connected) {
      setStatus({ text: "Connect wallet first", error: true });
      return;
    }
    const numA = Number.parseFloat(amtA);
    const numB = Number.parseFloat(amtB);
    if (!Number.isFinite(numA) || numA <= 0 || !Number.isFinite(numB) || numB <= 0) {
      setStatus({ text: "Enter positive amounts for both sides", error: true });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const rawA = toRaw(numA, decA);
      const rawB = toRaw(numB, decB);

      // Expected LP mint, mirroring pool.move's internal formula.
      let expectedLp: bigint;
      if (!pool || pool.lpSupply === 0n || !hasReserves) {
        // sqrt(rawA * rawB) for first-seed deposits — same as Uniswap V2.
        const prod = Number(rawA) * Number(rawB);
        expectedLp = BigInt(Math.floor(Math.sqrt(prod)));
      } else {
        const lpFromA = (rawA * pool.lpSupply) / pool.reserveA;
        const lpFromB = (rawB * pool.lpSupply) / pool.reserveB;
        expectedLp = lpFromA < lpFromB ? lpFromA : lpFromB;
      }
      const slipBps = BigInt(Math.floor((1 - slippage) * 10_000));
      const minShares = (expectedLp * slipBps) / 10_000n;

      const deadline = Math.floor(Date.now() / 1000) + 300;
      const result = await signAndSubmitTransaction({
        data: {
          function: `${PACKAGE}::pool::add_liquidity_entry`,
          typeArguments: [],
          functionArguments: [
            target.poolAddr,
            rawA.toString(),
            rawB.toString(),
            minShares.toString(),
            deadline.toString(),
          ],
        },
      });
      setStatus({
        text: `Submitted: ${result.hash.slice(0, 12)}…`,
        error: false,
      });
      setAmtA("");
      setAmtB("");
      balA.refresh();
      balB.refresh();
      onDone?.();
    } catch (e) {
      setStatus({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  const price = hasReserves && pool
    ? (Number(pool.reserveB) / 10 ** decB) / (Number(pool.reserveA) / 10 ** decA)
    : null;

  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={`Add liquidity — ${target.symbolA}/${target.symbolB}`}
    >
      <div className="modal-note">
        Uses Uniswap V2-style optimal amount computation — any slippage buffer you provide
        stays in your wallet if it isn't needed. Slippage: {(slippage * 100).toFixed(
          slippage < 0.01 ? 2 : 1,
        )}
        %
      </div>

      <label>Amount {target.symbolA}</label>
      <input
        type="number"
        value={amtA}
        onChange={(e) => onChangeA(e.target.value)}
        min="0"
        placeholder="0.0"
      />
      {connected && (
        <button
          type="button"
          className="bal-link bal-link-modal"
          onClick={setMaxA}
          disabled={balA.raw === 0n}
        >
          Balance: {balA.loading ? "…" : balA.formatted.toFixed(6)} {target.symbolA}
        </button>
      )}

      <label>Amount {target.symbolB}</label>
      <input
        type="number"
        value={amtB}
        onChange={(e) => onChangeB(e.target.value)}
        min="0"
        placeholder="0.0"
      />
      {connected && (
        <button
          type="button"
          className="bal-link bal-link-modal"
          onClick={setMaxB}
          disabled={balB.raw === 0n}
        >
          Balance: {balB.loading ? "…" : balB.formatted.toFixed(6)} {target.symbolB}
        </button>
      )}

      {poolLoading && <div className="modal-note">Loading pool state…</div>}
      {price !== null && (
        <div className="modal-note">
          1 {target.symbolA} ≈ {price.toFixed(6)} {target.symbolB}
        </div>
      )}
      {!poolLoading && pool && pool.lpSupply === 0n && (
        <div className="modal-note">
          First-seed deposit — you set the initial ratio. Mints{" "}
          <code>sqrt(rawA × rawB)</code> LP shares.
        </div>
      )}

      {status && (
        <div className={`modal-status ${status.error ? "error" : ""}`}>{status.text}</div>
      )}

      <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
        {busy ? "Submitting…" : "Add liquidity"}
      </button>
    </Modal>
  );
}
