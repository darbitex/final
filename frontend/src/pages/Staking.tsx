import { useWallet } from "@aptos-labs/wallet-adapter-react";
import { useCallback, useEffect, useState } from "react";
import { STAKING_PACKAGE, TOKENS } from "../config";
import { createRpcPool, fromRaw } from "../chain/rpc-pool";
import { useAddress } from "../wallet/useConnect";

const rpc = createRpcPool("staking");

type StakeEntry = {
  addr: string;
  rewardPoolAddr: string;
  positionAddr: string;
  shares: number;
  pending: number;
  rewardSymbol: string;
  rewardDecimals: number;
  poolAddr: string;
};

type PoolEntry = {
  addr: string;
  poolAddr: string;
  rewardToken: string;
  rewardSymbol: string;
  maxRate: number;
  stakeTarget: number;
  totalStaked: number;
  rewardBalance: number;
  rewardDecimals: number;
};

function resolveToken(meta: string): { symbol: string; decimals: number } {
  const norm = meta.replace(/^0x0+/, "0x").toLowerCase();
  for (const t of Object.values(TOKENS)) {
    if (t.meta.replace(/^0x0+/, "0x").toLowerCase() === norm) {
      return { symbol: t.symbol, decimals: t.decimals };
    }
  }
  return { symbol: meta.slice(0, 10) + "…", decimals: 8 };
}

function fmtAmount(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(n < 1 ? 6 : 2);
}

async function fetchUserStakes(owner: string): Promise<StakeEntry[]> {
  const owned = await rpc.primary.getAccountOwnedObjects({
    accountAddress: owner,
    options: { limit: 500 },
  });
  const results: StakeEntry[] = [];
  for (const obj of owned) {
    const addr = obj.object_address;
    if (!addr) continue;
    try {
      const [rewardPoolAddr, positionAddr, sharesRaw] =
        await rpc.rotatedView<[string, string, string]>({
          function: `${STAKING_PACKAGE}::staking::stake_info`,
          typeArguments: [],
          functionArguments: [addr],
        });

      const [poolAddr, rewardToken, , , ,] =
        await rpc.rotatedView<[string, string, string, string, string, string]>({
          function: `${STAKING_PACKAGE}::staking::reward_pool_info`,
          typeArguments: [],
          functionArguments: [rewardPoolAddr],
        });

      const pendingRaw = await rpc.rotatedView<[string]>({
        function: `${STAKING_PACKAGE}::staking::stake_pending_reward`,
        typeArguments: [],
        functionArguments: [addr],
      });

      const rwd = resolveToken(rewardToken);
      results.push({
        addr,
        rewardPoolAddr,
        positionAddr,
        shares: Number(sharesRaw),
        pending: fromRaw(pendingRaw[0], rwd.decimals),
        rewardSymbol: rwd.symbol,
        rewardDecimals: rwd.decimals,
        poolAddr,
      });
    } catch {
      // not an LpStakePosition
    }
  }
  return results;
}

async function fetchRewardPools(): Promise<PoolEntry[]> {
  try {
    const events = await fetch("https://api.mainnet.aptoslabs.com/v1/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{
          events(
            where: {type: {_eq: "${STAKING_PACKAGE}::staking::LpRewardPoolCreated"}}
            order_by: {transaction_version: desc}
            limit: 50
          ) { data }
        }`,
      }),
    }).then((r) => r.json());

    const poolEvents = events?.data?.events ?? [];
    const results: PoolEntry[] = [];

    for (const ev of poolEvents) {
      const d = ev.data as {
        reward_pool_addr: string;
        pool_addr: string;
        reward_token: string;
      };
      try {
        const [poolAddr, rewardToken, maxRateRaw, stakeTargetRaw, totalStakedRaw, rewardBalRaw] =
          await rpc.rotatedView<[string, string, string, string, string, string]>({
            function: `${STAKING_PACKAGE}::staking::reward_pool_info`,
            typeArguments: [],
            functionArguments: [d.reward_pool_addr],
          });
        const rwd = resolveToken(rewardToken);
        results.push({
          addr: d.reward_pool_addr,
          poolAddr,
          rewardToken,
          rewardSymbol: rwd.symbol,
          maxRate: fromRaw(maxRateRaw, rwd.decimals),
          stakeTarget: Number(stakeTargetRaw),
          totalStaked: Number(totalStakedRaw),
          rewardBalance: fromRaw(rewardBalRaw, rwd.decimals),
          rewardDecimals: rwd.decimals,
        });
      } catch {
        // pool may not exist anymore
      }
    }
    return results;
  } catch {
    return [];
  }
}

export function StakingPage() {
  const address = useAddress();
  const { signAndSubmitTransaction } = useWallet();

  const [stakes, setStakes] = useState<StakeEntry[]>([]);
  const [pools, setPools] = useState<PoolEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [s, p] = await Promise.all([
        address ? fetchUserStakes(address) : Promise.resolve([]),
        fetchRewardPools(),
      ]);
      setStakes(s);
      setPools(p);
    } catch (e) {
      console.error("[staking]", e);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleClaimRewards = useCallback(async (stakeAddr: string) => {
    setMsg(null);
    try {
      const r = await signAndSubmitTransaction({
        data: {
          function: `${STAKING_PACKAGE}::staking::claim_rewards`,
          typeArguments: [],
          functionArguments: [stakeAddr],
        },
      });
      setMsg({ text: `Rewards claimed: ${r.hash.slice(0, 12)}…`, error: false });
      loadData();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [signAndSubmitTransaction, loadData]);

  const handleClaimLpFees = useCallback(async (stakeAddr: string) => {
    setMsg(null);
    try {
      const r = await signAndSubmitTransaction({
        data: {
          function: `${STAKING_PACKAGE}::staking::claim_lp_fees`,
          typeArguments: [],
          functionArguments: [stakeAddr],
        },
      });
      setMsg({ text: `LP fees claimed: ${r.hash.slice(0, 12)}…`, error: false });
      loadData();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [signAndSubmitTransaction, loadData]);

  const handleUnstake = useCallback(async (stakeAddr: string) => {
    setMsg(null);
    try {
      const r = await signAndSubmitTransaction({
        data: {
          function: `${STAKING_PACKAGE}::staking::unstake_lp`,
          typeArguments: [],
          functionArguments: [stakeAddr],
        },
      });
      setMsg({ text: `Unstaked: ${r.hash.slice(0, 12)}…`, error: false });
      loadData();
    } catch (e) {
      setMsg({ text: (e as Error).message, error: true });
    }
  }, [signAndSubmitTransaction, loadData]);

  return (
    <div className="container">
      <h1 className="page-title">LP Staking</h1>
      <p className="page-sub">
        Stake Darbitex LP positions, earn rewards. Claim LP swap fees while staked.
      </p>

      {msg && (
        <div className={`modal-status ${msg.error ? "error" : ""}`} style={{ marginBottom: 12 }}>
          {msg.text}
        </div>
      )}

      {address && stakes.length > 0 && (
        <div className="card" style={{ padding: 16 }}>
          <h2 className="section-title">Your Staked Positions</h2>
          {stakes.map((s) => (
            <div key={s.addr} className="vault-row">
              <div className="vault-row-info">
                <strong>{s.shares.toLocaleString()} shares</strong>
                <span className="dim">
                  Pool {s.poolAddr.slice(0, 10)}…
                </span>
                {s.pending > 0 && (
                  <span style={{ color: "#00cc55", fontSize: 11 }}>
                    {fmtAmount(s.pending)} {s.rewardSymbol} pending
                  </span>
                )}
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  className="btn btn-secondary"
                  disabled={s.pending <= 0}
                  onClick={() => handleClaimRewards(s.addr)}
                >
                  Claim
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => handleClaimLpFees(s.addr)}
                >
                  LP Fees
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => handleUnstake(s.addr)}
                >
                  Unstake
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ padding: 16, marginTop: 12 }}>
        <h2 className="section-title">Reward Pools</h2>
        <p style={{ fontSize: 11, color: "#666", marginBottom: 10 }}>
          Active LP staking reward pools. Stake your LP positions from the Portfolio page.
        </p>
        {loading ? (
          <div className="dim" style={{ fontSize: 12 }}>Loading…</div>
        ) : pools.length === 0 ? (
          <div className="dim" style={{ fontSize: 12 }}>No reward pools yet.</div>
        ) : (
          <div className="vault-directory">
            <div className="vault-dir-header">
              <span>Reward</span>
              <span>Staked</span>
              <span>Balance</span>
            </div>
            {pools.map((p) => (
              <div key={p.addr} className="vault-dir-row">
                <span><strong>{p.rewardSymbol}</strong></span>
                <span>{p.totalStaked.toLocaleString()}</span>
                <span>{fmtAmount(p.rewardBalance)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {!address && (
        <p className="page-sub" style={{ marginTop: 12 }}>
          Connect your wallet to view your staked positions.
        </p>
      )}
    </div>
  );
}
