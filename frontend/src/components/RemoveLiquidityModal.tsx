import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useEffect, useState } from "react";
import { PACKAGE } from "../config";
import { createRpcPool, fromRaw } from "../chain/rpc-pool";
import { useAddress } from "../wallet/useConnect";
import { Modal } from "./Modal";

export type RemoveTarget = {
  poolAddr: string;
  symbolA: string;
  symbolB: string;
  decA?: number;
  decB?: number;
};

// Pool-state reader for proportional preview + auto-discovery path.
const rpc = createRpcPool("remove-liquidity");

type PoolResource = {
  reserve_a: string | number;
  reserve_b: string | number;
  lp_supply: string | number;
};

type LpPositionResource = {
  pool_addr: string;
  shares: string | number;
};

type DiscoveredPosition = {
  objectAddr: string;
  shares: bigint;
};

async function fetchPool(poolAddr: string) {
  try {
    const d = await rpc.rotatedGetResource<PoolResource>(
      poolAddr,
      `${PACKAGE}::pool::Pool`,
    );
    return {
      reserveA: BigInt(String(d.reserve_a ?? "0")),
      reserveB: BigInt(String(d.reserve_b ?? "0")),
      lpSupply: BigInt(String(d.lp_supply ?? "0")),
    };
  } catch {
    return null;
  }
}

// Discover LP positions the user owns for a specific pool.
// Uses the indexer's getAccountOwnedObjects to list every object the
// wallet holds, then reads each candidate's Move resource to filter by
// the LpPosition type + matching pool_addr. Indexer lag can make this
// return empty transiently; the modal always keeps manual paste as a
// fallback path.
async function discoverLpPositions(
  owner: string,
  poolAddr: string,
): Promise<DiscoveredPosition[]> {
  try {
    const owned = await rpc.primary.getAccountOwnedObjects({
      accountAddress: owner,
    });
    const out: DiscoveredPosition[] = [];
    for (const obj of owned) {
      const objAddr = obj.object_address;
      if (!objAddr) continue;
      try {
        const res = await rpc.rotatedGetResource<LpPositionResource>(
          objAddr,
          `${PACKAGE}::pool::LpPosition`,
        );
        const owningPool = String(res.pool_addr ?? "").toLowerCase();
        if (owningPool === poolAddr.toLowerCase()) {
          out.push({
            objectAddr: objAddr,
            shares: BigInt(String(res.shares ?? "0")),
          });
        }
      } catch {
        // Not an LpPosition — skip silently. Reading wrong-type resource
        // returns a "resource not found" error.
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function RemoveLiquidityModal({
  target,
  onClose,
  onDone,
}: {
  target: RemoveTarget | null;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { signAndSubmitTransaction, connected } = useWallet();
  const address = useAddress();
  const [positionAddr, setPositionAddr] = useState("");
  const [manual, setManual] = useState(false);
  const [positions, setPositions] = useState<DiscoveredPosition[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [pool, setPool] = useState<{
    reserveA: bigint;
    reserveB: bigint;
    lpSupply: bigint;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);

  const decA = target?.decA ?? 8;
  const decB = target?.decB ?? 6;

  useEffect(() => {
    if (!target) {
      setPool(null);
      setPositions([]);
      setPositionAddr("");
      setManual(false);
      return;
    }
    let cancelled = false;

    fetchPool(target.poolAddr).then((p) => {
      if (!cancelled) setPool(p);
    });

    if (address) {
      setDiscovering(true);
      discoverLpPositions(address, target.poolAddr)
        .then((list) => {
          if (cancelled) return;
          setPositions(list);
          if (list.length > 0) {
            setPositionAddr(list[0].objectAddr);
          }
        })
        .finally(() => {
          if (!cancelled) setDiscovering(false);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [target, address]);

  if (!target) return null;

  // Proportional preview — what the selected position would return if
  // removed at current reserves. Approximate (reserves shift between
  // read + submit). Slippage floor stays user-set via min inputs.
  const selected = positions.find((p) => p.objectAddr === positionAddr);
  let expectedA = 0n;
  let expectedB = 0n;
  if (pool && selected && pool.lpSupply > 0n) {
    expectedA = (pool.reserveA * selected.shares) / pool.lpSupply;
    expectedB = (pool.reserveB * selected.shares) / pool.lpSupply;
  }

  async function submit() {
    if (!connected || !address) {
      setStatus({ text: "Connect wallet first", error: true });
      return;
    }
    const posAddr = positionAddr.trim();
    if (!/^0x[0-9a-f]+$/i.test(posAddr)) {
      setStatus({ text: "Select or paste a valid LpPosition address", error: true });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      // Default min-out floor = 99% of expected (1% slippage headroom)
      // if we have pool state; 0 otherwise. Manual override lands if the
      // user explicitly typed a min.
      const minA = expectedA > 0n ? (expectedA * 99n) / 100n : 0n;
      const minB = expectedB > 0n ? (expectedB * 99n) / 100n : 0n;
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const result = await signAndSubmitTransaction({
        data: {
          function: `${PACKAGE}::pool::remove_liquidity_entry`,
          typeArguments: [],
          functionArguments: [
            posAddr,
            minA.toString(),
            minB.toString(),
            deadline.toString(),
          ],
        },
      });
      setStatus({
        text: `Submitted: ${result.hash.slice(0, 12)}…`,
        error: false,
      });
      onDone?.();
    } catch (e) {
      setStatus({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={`Remove liquidity — ${target.symbolA}/${target.symbolB}`}
    >
      <div className="modal-note">
        Burns an LpPosition object and returns proportional reserves plus any accumulated
        fees. Positions are auto-discovered from your wallet.
      </div>

      {!address && (
        <div className="modal-status error">Connect wallet to load your positions.</div>
      )}

      {address && !manual && (
        <>
          <label>Your positions in this pool</label>
          {discovering ? (
            <div className="modal-note">Scanning owned objects…</div>
          ) : positions.length === 0 ? (
            <div className="modal-note">
              No LP positions found for this pool in your wallet. Indexer lag can hide
              fresh positions for a minute or two — try the manual path below if you know
              the object address.
            </div>
          ) : (
            <select
              value={positionAddr}
              onChange={(e) => setPositionAddr(e.target.value)}
            >
              {positions.map((p) => (
                <option key={p.objectAddr} value={p.objectAddr}>
                  {p.objectAddr.slice(0, 10)}…{p.objectAddr.slice(-4)} · {p.shares.toString()} shares
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="bal-link bal-link-modal"
            onClick={() => setManual(true)}
          >
            Or paste an object address manually →
          </button>
        </>
      )}

      {address && manual && (
        <>
          <label>LpPosition object address</label>
          <input
            type="text"
            value={positionAddr}
            onChange={(e) => setPositionAddr(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
          />
          <button
            type="button"
            className="bal-link bal-link-modal"
            onClick={() => setManual(false)}
          >
            ← Back to auto-discovered positions
          </button>
        </>
      )}

      {pool && selected && (
        <div className="modal-note">
          Expected out: {fromRaw(expectedA, decA).toFixed(6)} {target.symbolA} ·{" "}
          {fromRaw(expectedB, decB).toFixed(6)} {target.symbolB} (1% slippage floor applied
          on submit)
        </div>
      )}

      {status && (
        <div className={`modal-status ${status.error ? "error" : ""}`}>{status.text}</div>
      )}

      <button
        type="button"
        className="btn btn-primary"
        onClick={submit}
        disabled={busy || !positionAddr}
      >
        {busy ? "Submitting…" : "Remove liquidity"}
      </button>
    </Modal>
  );
}
