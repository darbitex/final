import { useEffect, useMemo, useState } from "react";
import { useAddress } from "../../wallet/useConnect";
import { useFaBalance, fetchFaBalance, fetchFaMetadata } from "../../chain/balance";
import { createRpcPool, fromRaw } from "../../chain/rpc-pool";
import { TOKENS, DESNET_FA } from "../../config";
import { handleOfWallet, validateHandle } from "../../chain/desnet/profile";
import { tokenMetadataAddr } from "../../chain/desnet/amm";
import { isForeverLocked, loadPosition, pendingAll, type Position } from "../../chain/desnet/staking";
import { APT_VIEW } from "../../chain/desnet/tokenIcon";
import { TokenIcon } from "../../components/TokenIcon";

const APT = TOKENS.APT;
const rpc = createRpcPool("desnet-portfolio");

const KEY_TRACKED_HANDLES = (owner: string) => `desnet.tracked-handles.${owner}`;
const KEY_LP_FOR = (handle: string, owner: string) => `desnet.lp.${owner}.${handle}`;

function readTrackedHandles(owner: string): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY_TRACKED_HANDLES(owner));
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    // Always include `desnet` as a baseline so DESNET token shows up.
    return Array.from(new Set([...arr, "desnet"])).filter((h) => !validateHandle(h));
  } catch {
    return ["desnet"];
  }
}

function writeTrackedHandles(owner: string, list: string[]): void {
  localStorage.setItem(KEY_TRACKED_HANDLES(owner), JSON.stringify(list));
}

function readLpAddrs(handle: string, owner: string): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY_LP_FOR(handle, owner));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

type TokenRow = {
  handle: string;
  symbol: string;
  meta: string;
  balance: bigint;
  iconUri?: string;
};

type PositionRow = {
  handle: string;
  meta: Position;
  pending: [bigint, bigint, bigint];
};

export function Portfolio() {
  const address = useAddress();
  const aptBal = useFaBalance(APT.meta, APT.decimals);

  const [myHandle, setMyHandle] = useState<string | null | undefined>(undefined);
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [trackInput, setTrackInput] = useState("");
  const [loading, setLoading] = useState(false);
  // Bumped whenever the tracked-handles list changes so dependent effects re-run.
  // Cheaper + better UX than location.reload(), preserves scroll/expanded details.
  const [tick, setTick] = useState(0);

  // Resolve connected wallet's handle (if any)
  useEffect(() => {
    let cancelled = false;
    if (!address) {
      setMyHandle(undefined);
      return;
    }
    setMyHandle(undefined);
    handleOfWallet(rpc, address).then((h) => {
      if (!cancelled) setMyHandle(h);
    });
    return () => {
      cancelled = true;
    };
  }, [address]);

  // For each tracked handle: resolve token meta + your balance + your positions.
  useEffect(() => {
    let cancelled = false;
    if (!address) {
      setTokens([]);
      setPositions([]);
      return;
    }
    setLoading(true);
    const handles = readTrackedHandles(address);
    Promise.all(
      handles.map(async (h) => {
        try {
          // For the protocol DESNET handle, the FA addr is hardcoded —
          // skip the pool-side resolution to save one round-trip.
          const meta = h === "desnet" ? DESNET_FA : await tokenMetadataAddr(rpc, h);
          const [bal, faMeta] = await Promise.all([
            fetchFaBalance(address, meta),
            fetchFaMetadata(meta),
          ]);
          const symbol = faMeta?.symbol ?? h.toUpperCase();
          // Bundled icon for desnet (and any future curated handle); else use
          // the on-chain icon_uri from FA metadata.
          const bundled = h === "desnet" ? "/tokens/desnet.svg" : undefined;
          const iconUri = bundled ?? faMeta?.iconUri;
          return {
            token: { handle: h, symbol, meta, balance: bal, iconUri } as TokenRow,
            positions: await loadHandlePositions(h, address),
          };
        } catch {
          return { token: null, positions: [] };
        }
      }),
    ).then((rows) => {
      if (cancelled) return;
      const tokRows = rows
        .map((r) => r.token)
        .filter((x): x is TokenRow => !!x)
        .sort((a, b) => Number(b.balance - a.balance));
      const posRows = rows.flatMap((r) => r.positions);
      setTokens(tokRows);
      setPositions(posRows);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [address, tick]);

  const totalPendingApt = useMemo(
    () => positions.reduce((acc, p) => acc + p.pending[1], 0n),
    [positions],
  );
  const totalPendingTokenByHandle = useMemo(() => {
    const out = new Map<string, bigint>();
    for (const p of positions) {
      const cur = out.get(p.handle) ?? 0n;
      out.set(p.handle, cur + p.pending[0] + p.pending[2]);
    }
    return out;
  }, [positions]);

  function addHandle() {
    const h = trackInput.toLowerCase().trim();
    if (!h || validateHandle(h) || !address) return;
    const existing = readTrackedHandles(address);
    if (existing.includes(h)) return;
    writeTrackedHandles(address, [...existing, h]);
    setTrackInput("");
    setTick((t) => t + 1);
  }

  function removeHandle(h: string) {
    if (!address) return;
    const list = readTrackedHandles(address).filter((x) => x !== h && x !== "desnet");
    writeTrackedHandles(address, list);
    setTick((t) => t + 1);
  }

  if (!address) {
    return (
      <div className="card">
        <h2>Portfolio</h2>
        <p className="muted">Connect a wallet to see your holdings, PIDs, and positions across DeSNet handles.</p>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <h2>Identity</h2>
        {myHandle === undefined ? (
          <p className="muted">Checking…</p>
        ) : myHandle ? (
          <p>
            Your wallet holds the PID for <strong>@{myHandle}</strong>.{" "}
            <a href={`/desnet/p/${myHandle}`}>View profile →</a>
          </p>
        ) : (
          <p className="muted">
            No PID under this wallet. <a href="/desnet/register">Register a handle →</a>
          </p>
        )}
        <p className="muted small">
          Per-wallet PID is hard-coded by Move (one PID per wallet, forever).
          Multi-identity = multi-wallet (standard web3 hygiene).
        </p>
      </div>

      <div className="card">
        <h2>Holdings</h2>
        <div className="card-stat">
          <div><TokenIcon token={APT_VIEW} size={14} /> APT</div>
          <div>
            <strong>{aptBal.formatted.toLocaleString()}</strong>
          </div>
        </div>
        {loading ? (
          <p className="muted">Loading $TOKEN balances…</p>
        ) : tokens.length === 0 ? (
          <p className="muted">No tracked $TOKENs.</p>
        ) : (
          tokens.map((t) => (
            <div key={t.handle} className="card-stat">
              <div>
                <TokenIcon token={{ symbol: t.symbol, icon: t.iconUri }} size={14} />{" "}
                ${t.symbol}{" "}
                <a href={`/desnet/swap?h=${t.handle}`} className="link small">
                  swap
                </a>{" "}
                <a href={`/desnet/p/${t.handle}`} className="link small">
                  profile
                </a>{" "}
                {t.handle !== "desnet" && (
                  <button
                    className="link small"
                    onClick={() => removeHandle(t.handle)}
                  >
                    untrack
                  </button>
                )}
              </div>
              <div>
                <strong>{fromRaw(t.balance, 8).toLocaleString()}</strong>
              </div>
            </div>
          ))
        )}
        <details>
          <summary>Track another handle</summary>
          <div className="grid-2">
            <input
              value={trackInput}
              onChange={(e) => setTrackInput(e.target.value.toLowerCase())}
              placeholder="alice"
            />
            <button onClick={addHandle} disabled={!trackInput || !!validateHandle(trackInput)}>
              Track
            </button>
          </div>
          <p className="muted small">
            Adds the handle's $TOKEN to your portfolio view. Stored in browser
            local storage. <code>desnet</code> is always tracked.
          </p>
        </details>
      </div>

      <div className="card">
        <h2>LP positions</h2>
        {positions.length === 0 ? (
          <p className="muted">
            No tracked positions. Add liquidity from the{" "}
            <a href="/desnet/liquidity">Liquidity tab</a> to populate this.
          </p>
        ) : (
          <>
            <div className="card-stat">
              <div>Total pending APT</div>
              <div>
                <strong>{fromRaw(totalPendingApt, APT.decimals).toFixed(6)}</strong> APT
              </div>
            </div>
            {[...totalPendingTokenByHandle].map(([handle, raw]) => (
              <div key={handle} className="card-stat">
                <div>Total pending ${handle.toUpperCase()}</div>
                <div>
                  <strong>{fromRaw(raw, 8).toFixed(6)}</strong>
                </div>
              </div>
            ))}
            <div className="position-list">
              {positions.map(({ handle, meta, pending }) => {
                const [emission, feeApt, feeTok] = pending;
                const locked = isForeverLocked(meta.unlockAtSecs);
                return (
                  <div key={meta.positionAddr} className="position-row">
                    <div>
                      <div className="mono small">
                        @{handle} · {meta.positionAddr.slice(0, 10)}…
                      </div>
                      <div className="muted small">
                        Shares {meta.shares.toString()} ·{" "}
                        {locked
                          ? "forever-locked"
                          : meta.unlockAtSecs > 0
                          ? `unlocks ${new Date(meta.unlockAtSecs * 1000).toISOString().slice(0, 10)}`
                          : "free"}
                      </div>
                      <div className="muted small">
                        Pending: {fromRaw(emission, 8).toFixed(6)} ${handle.toUpperCase()}{" "}
                        + {fromRaw(feeApt, 8).toFixed(6)} APT +{" "}
                        {fromRaw(feeTok, 8).toFixed(6)} ${handle.toUpperCase()}
                      </div>
                    </div>
                    <div>
                      <a
                        className="link small"
                        href={`/desnet/liquidity?h=${handle}`}
                      >
                        manage →
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
        <p className="muted small">
          Position addresses are tracked in browser local storage. New positions
          you create from the Liquidity tab register here automatically. To
          import positions made on another device, paste the address from the
          Liquidity tab's "Import a position" details.
        </p>
      </div>
    </>
  );
}

async function loadHandlePositions(
  handle: string,
  owner: string,
): Promise<PositionRow[]> {
  const addrs = readLpAddrs(handle, owner);
  const out: PositionRow[] = [];
  for (const addr of addrs) {
    const meta = await loadPosition(rpc, addr);
    if (!meta) continue;
    const pending = await pendingAll(rpc, addr);
    out.push({ handle, meta, pending });
  }
  return out;
}
