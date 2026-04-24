import { useEffect, useState } from "react";
import { INITIAL_POOLS, PACKAGE, POOL_FEE_BPS, TOKENS, TREASURY, TREASURY_BPS } from "../config";
import { createRpcPool, fromRaw } from "../chain/rpc-pool";

const rpc = createRpcPool("about");

type PoolSnapshot = {
  address: string;
  symbolA: string;
  symbolB: string;
  reserveA: bigint;
  reserveB: bigint;
};

type VolumeAggregate = {
  perToken: Record<string, bigint>;
  eventCount: number;
  indexerFailed: boolean;
};

function decimalsOf(symbol: string): number {
  return TOKENS[symbol]?.decimals ?? 0;
}

export function AboutPage() {
  const [poolCount, setPoolCount] = useState<number | null>(null);
  const [pools, setPools] = useState<PoolSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [volume, setVolume] = useState<VolumeAggregate | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [all] = await rpc.viewFn<[string[]]>("pool_factory::get_all_pools", [], []);
        if (!cancelled) setPoolCount(all.length);
      } catch {
        if (!cancelled) setPoolCount(null);
      }

      const snapshots = await Promise.all(
        INITIAL_POOLS.map(async (p) => {
          try {
            const [rA, rB] = await rpc.viewFn<[string, string]>(
              "pool::reserves",
              [],
              [p.address],
            );
            return {
              address: p.address,
              symbolA: p.symbolA,
              symbolB: p.symbolB,
              reserveA: BigInt(rA),
              reserveB: BigInt(rB),
            };
          } catch {
            return null;
          }
        }),
      );
      if (!cancelled) {
        setPools(snapshots.filter((s): s is PoolSnapshot => s !== null));
        setLoading(false);
      }

      try {
        type EventRow = {
          data: { pool_addr?: string; amount_in?: string; a_to_b?: boolean };
        };
        type EventsQuery = { events: EventRow[] };
        const query = {
          query: `query SwappedEvents($type: String!) {
            events(
              where: { indexed_type: { _eq: $type } }
              limit: 500
              order_by: { transaction_version: desc }
            ) {
              data
            }
          }`,
          variables: { type: `${PACKAGE}::pool::Swapped` },
        };
        const result = await rpc.primary.queryIndexer<EventsQuery>({ query });
        if (cancelled) return;
        const perToken: Record<string, bigint> = {};
        let eventCount = 0;
        for (const ev of result.events ?? []) {
          const d = ev.data;
          const poolAddr = String(d.pool_addr ?? "").toLowerCase();
          const amtIn = BigInt(String(d.amount_in ?? "0"));
          const aToB = !!d.a_to_b;
          const poolSeed = INITIAL_POOLS.find(
            (p) => p.address.toLowerCase() === poolAddr,
          );
          if (!poolSeed) continue;
          const sideSymbol = aToB ? poolSeed.symbolA : poolSeed.symbolB;
          perToken[sideSymbol] = (perToken[sideSymbol] ?? 0n) + amtIn;
          eventCount += 1;
        }
        setVolume({ perToken, eventCount, indexerFailed: false });
      } catch {
        if (!cancelled) {
          setVolume({ perToken: {}, eventCount: 0, indexerFailed: true });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const tvlByToken: Record<string, bigint> = {};
  for (const p of pools) {
    tvlByToken[p.symbolA] = (tvlByToken[p.symbolA] ?? 0n) + p.reserveA;
    tvlByToken[p.symbolB] = (tvlByToken[p.symbolB] ?? 0n) + p.reserveB;
  }
  const tvlEntries = Object.entries(tvlByToken).sort(([a], [b]) => a.localeCompare(b));
  const volumeEntries = volume
    ? Object.entries(volume.perToken).sort(([a], [b]) => a.localeCompare(b))
    : [];

  return (
    <div className="container about">
      <h1 className="page-title">About</h1>
      <p className="tagline">Decentralized Arbitrage Exchange on Aptos</p>

      <div className="about-grid">
        <div className="about-stat">
          <div className="big">1</div>
          <div className="label">BPS LP FEE</div>
        </div>
        <div className="about-stat">
          <div className="big">9</div>
          <div className="label">ON-CHAIN MODULES</div>
        </div>
        <div className="about-stat">
          <div className="big">0</div>
          <div className="label">ADMIN FUNCTIONS</div>
        </div>
        <div className="about-stat">
          <div className="big">0</div>
          <div className="label">SERVERS</div>
        </div>
      </div>

      <h2 className="section-title">What is Darbitex?</h2>
      <p>
        Darbitex is a <strong>fully decentralized exchange ecosystem</strong> on{" "}
        <strong>Aptos</strong>. At its core is a surplus-fee AMM: an immutable{" "}
        <code>x &times; y = k</code> pool paired with a composable routing layer
        that charges <strong>10% only on measurable surplus</strong> over what a
        direct swap would have produced. No surplus, no fee.
      </p>
      <p>
        Around this core sits a constellation of <strong>satellite packages</strong>
        &mdash; each is an independent on-chain module that composes the core's
        public primitives without requiring any upgrade to the core itself.
        Cross-venue aggregation, flash arbitrage, token creation, time-locked
        vaults, LP staking, and the ONE stablecoin &mdash; all live on-chain with
        zero admin surface, zero servers, and zero backend.
      </p>

      <h2 className="section-title">Core AMM &mdash; the two counters</h2>
      <p>
        <strong>Counter 1 &mdash; the pool.</strong> A vending machine. You put
        1 APT in, you get the exact amount of USDC the <code>x &times; y = k</code>{" "}
        curve says you get, minus a 1 bps fee that goes entirely to the LPs who
        stocked the machine. No opinions, no strategies, no callbacks, no admin.
      </p>
      <p>
        <strong>Counter 2 &mdash; arbitrage.</strong> A smart clerk. You hand your
        APT and say "get me USDC". The clerk simulates the direct route and every
        multi-hop route, picks whichever produces more, and hands you the output.
        If the smart route beat the direct vending machine swap, the clerk keeps 10%
        of the <em>difference</em>. If there was no difference, the clerk keeps nothing.
      </p>
      <p>
        The clerk also runs flash-loan triangle arbitrage: borrow from pool A, cycle
        through B &rarr; C &rarr; A, repay the loan. 90% of profit to the caller,
        10% to treasury. Anyone can trigger it.
      </p>

      <h2 className="section-title">The 10% rule</h2>
      <p>
        Darbitex charges 10% only on <strong>measurable surplus</strong>: the delta
        between what the routed trade produced and what a direct canonical pool swap
        would have produced. Swap $1 and receive $1 &mdash; no charge. Swap $1 and
        receive $1.10 thanks to multi-hop routing &mdash; we take $0.01.
      </p>
      <p>
        <strong>No baseline = no charge.</strong> If the direct pool doesn't exist,
        there is no reference point, so the entire output goes to the caller.
        Enforced in code, not convention.
      </p>
      <p>
        The 1 bps swap fee goes 100% to LPs. There is no passive protocol fee slot.
      </p>

      <h2 className="section-title">Satellite ecosystem</h2>
      <p>
        Satellites are independent on-chain packages that compose the core's public
        primitives. Adding a new feature never requires a core upgrade.
      </p>

      <div className="about-satellites">
        <div className="about-sat">
          <strong>Cross-Venue Aggregator</strong>
          <span className="dim"> &mdash; </span>
          Compares quotes across Darbitex, Hyperion CLMM, ThalaSwap V2, and Cellana
          in parallel. Executes through whichever venue wins. Each external venue is
          wrapped in its own adapter satellite with primitive-only Move view/entry
          functions.
        </div>
        <div className="about-sat">
          <strong>Flash Arbitrage (Flashbot)</strong>
          <span className="dim"> &mdash; </span>
          Borrows from Aave V3 (0 fee), swaps through Darbitex + an external venue,
          repays, splits profit 90% caller / 10% treasury. Supports Thala, Hyperion,
          and Cellana routes. Anyone can trigger.
        </div>
        <div className="about-sat">
          <strong>Token Factory</strong>
          <span className="dim"> &mdash; </span>
          Create new FA tokens with a name and symbol. Tiered pricing (1-char:
          1000 APT down to 5+: 0.1 APT). Fixed 1B supply per token. Self-burn
          via BurnCap. No future minting. Permanently frozen on-chain.
        </div>
        <div className="about-sat">
          <strong>Token Vault</strong>
          <span className="dim"> &mdash; </span>
          Three modes for any FA token: time-based lock, linear vesting schedule,
          and staking with reward pools. Permissionless pool creation &mdash; anyone
          can set up a staking pool and deposit rewards. Permanently frozen on-chain.
        </div>
        <div className="about-sat">
          <strong>LP Staking</strong>
          <span className="dim"> &mdash; </span>
          Stake Darbitex LP positions into reward pools. Earn any reward token over
          time while still collecting LP swap fees. Anyone can create a reward pool
          for any Darbitex pool + any reward token.
        </div>
        <div className="about-sat">
          <strong>LP Locker</strong>
          <span className="dim"> &mdash; </span>
          Wraps LP positions with a time-based unlock gate. LP fees remain claimable
          while locked &mdash; only the principal is gated by the unlock timestamp.
          Used for protocol-owned liquidity locks.
        </div>
        <div className="about-sat">
          <strong>ONE &mdash; APT-collateralized stablecoin</strong>
          <span className="dim"> &mdash; </span>
          Retail-first, 1 ONE minimum debt, sealed. Pyth-oracled APT/USD. 200%
          MCR, 150% liquidation threshold, 10% bonus. Stability pool catches
          liquidations, surplus scrubs the peg. Package{" "}
          <code>0x85ee9c43…</code>, FA <code>0xee5ebaf6…</code>.
        </div>
      </div>

      <h2 className="section-title">Protocol &mdash; live state</h2>
      <p className="page-sub">
        Zero admin surface, hardcoded treasury, 3-of-5 publisher multisig,
        compatible upgrade policy during soak then immutable.
      </p>

      <section className="protocol-grid">
        <div className="protocol-card">
          <div className="protocol-label">Package / publisher multisig</div>
          <div className="protocol-addr">
            <a
              href={`https://explorer.aptoslabs.com/account/${PACKAGE}?network=mainnet`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {PACKAGE}
            </a>
          </div>
        </div>

        <div className="protocol-card">
          <div className="protocol-label">Treasury (hardcoded Move constant)</div>
          <div className="protocol-addr">
            <a
              href={`https://explorer.aptoslabs.com/account/${TREASURY}?network=mainnet`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {TREASURY}
            </a>
          </div>
        </div>

        <div className="protocol-card small">
          <div className="protocol-label">Pools on-chain</div>
          <div className="protocol-big">{poolCount === null ? "—" : poolCount}</div>
          <div className="protocol-note">
            Live count from <code>pool_factory::get_all_pools</code>
          </div>
        </div>

        <div className="protocol-card small">
          <div className="protocol-label">LP fee</div>
          <div className="protocol-big">{POOL_FEE_BPS} bps</div>
          <div className="protocol-note">100% to LPs &mdash; no passive protocol slot</div>
        </div>

        <div className="protocol-card small">
          <div className="protocol-label">Treasury cut</div>
          <div className="protocol-big">{TREASURY_BPS / 100}%</div>
          <div className="protocol-note">Only on measurable surplus over the direct baseline</div>
        </div>

        <div className="protocol-card small">
          <div className="protocol-label">Core modules</div>
          <div className="protocol-big">3</div>
          <div className="protocol-note">
            <code>pool</code> &middot; <code>pool_factory</code> &middot; <code>arbitrage</code>
          </div>
        </div>
      </section>

      <h2 className="section-title">TVL by token</h2>
      <div className="pool-table">
        <div className="pool-head">
          <span>Token</span>
          <span>Reserves summed</span>
        </div>
        {loading && <div className="hint">Loading reserves…</div>}
        {!loading && tvlEntries.length === 0 && <div className="hint">No pool data.</div>}
        {tvlEntries.map(([symbol, raw]) => (
          <div key={symbol} className="pool-row tvl-row">
            <span className="pair">{symbol}</span>
            <span className="reserves">{fromRaw(raw, decimalsOf(symbol)).toFixed(4)}</span>
          </div>
        ))}
      </div>

      <h2 className="section-title">Cumulative volume</h2>
      <div className="pool-table">
        <div className="pool-head">
          <span>Token (side in)</span>
          <span>Total volume</span>
        </div>
        {!volume && <div className="hint">Loading events…</div>}
        {volume?.indexerFailed && (
          <div className="hint">
            Indexer unavailable &mdash; volume requires the Aptos Labs indexer events API.
            Reserves above are read directly from fullnode and always live.
          </div>
        )}
        {volume && !volume.indexerFailed && volumeEntries.length === 0 && (
          <div className="hint">
            No swap events found yet. Counter starts at zero on the indexer.
          </div>
        )}
        {volume && !volume.indexerFailed && volumeEntries.length > 0 && (
          <>
            {volumeEntries.map(([symbol, raw]) => (
              <div key={symbol} className="pool-row tvl-row">
                <span className="pair">{symbol}</span>
                <span className="reserves">{fromRaw(raw, decimalsOf(symbol)).toFixed(4)}</span>
              </div>
            ))}
            <div className="hint">
              Lifetime volume from last {volume.eventCount} indexed <code>Swapped</code> events.
            </div>
          </>
        )}
      </div>

      <h2 className="section-title">Execution surfaces</h2>
      <div className="venue-table">
        <div className="venue-head">
          <span>Surface</span>
          <span>Role</span>
        </div>
        <div className="venue-row">
          <span className="venue-name"><code>execute_path</code></span>
          <span className="venue-out">Smart multi-hop swap along a pre-computed optimal path</span>
        </div>
        <div className="venue-row">
          <span className="venue-name"><code>swap</code></span>
          <span className="venue-out">Auto-routed in→out swap; finds the best path internally</span>
        </div>
        <div className="venue-row">
          <span className="venue-name"><code>close_triangle</code></span>
          <span className="venue-out">Real-capital cycle closure from caller's primary store</span>
        </div>
        <div className="venue-row">
          <span className="venue-name"><code>close_triangle_flash</code></span>
          <span className="venue-out">Flash-borrow → cycle → repay, zero up-front capital</span>
        </div>
      </div>

      <h2 className="section-title">Universal flash loans</h2>
      <p>
        Every pool supports flash loans at 1 bps. Flash receipts are hot-potato
        structs &mdash; no abilities, must be consumed by <code>flash_repay</code>{" "}
        in the same transaction or the tx aborts.{" "}
        <code>close_triangle_flash</code> uses this internally for zero-capital
        cycle closure.
      </p>

      <h2 className="section-title">Audit &mdash; 13 passes across 3 rounds</h2>
      <p>
        The core package went through 3 audit rounds with 13 independent AI auditor
        passes: Gemini 2.5 Pro, Grok 4, Qwen, Kimi K2, DeepSeek, ChatGPT GPT-5,
        Claude Opus 4.6, and Perplexity. 14 actionable fixes applied. All 5 R3
        auditors returned GREEN.
      </p>
      <p>
        Each satellite has its own audit trail (R1 minimum, 5 auditors each). The
        Token Vault, Token Factory, and ONE are permanently frozen on-chain after
        passing audit.
      </p>
      <p className="mute">Audits are aids, not guarantees. Read the code.</p>

      <h2 className="section-title">Fully decentralized</h2>
      <p>
        <strong>Smart contracts</strong> &mdash; on Aptos mainnet, published from a
        3-of-5 multisig. Launched under <code>compatible</code> upgrade policy during
        a 3&ndash;6 month soak. After the soak, upgrade policy flips to{" "}
        <code>immutable</code> &mdash; including the hardcoded treasury address and
        the 10% surplus rate.
      </p>
      <p>
        <strong>Frontend</strong> &mdash; hosted on Walrus (decentralized storage on
        Sui). No centralized server.
      </p>
      <p>
        <strong>Backend</strong> &mdash; there is none. All state lives on-chain.
        Pools, reserves, routes, and quotes are read directly from Aptos RPC.
      </p>

      <h2 className="section-title">When $DARBITEX?</h2>
      <p>
        The <strong>DARBITEX</strong> token has been created via the Token Factory
        satellite: 1 billion supply, 8 decimals. It is not yet in circulation.
      </p>
      <p>
        <strong>Launch criteria:</strong>
      </p>
      <p>
        <strong>1. POC proven.</strong> The core AMM, smart routing, flash arbitrage,
        cross-venue aggregation, token factory, vault, LP staking, LP locker, and
        the ONE stablecoin are all deployed and verified on Aptos mainnet. This
        milestone is complete.
      </p>
      <p>
        <strong>2. Treasury bootstrap.</strong> When the treasury accumulates{" "}
        <strong>100 APT</strong> from organic protocol fees (the 10% surplus charge +
        satellite creation fees), those funds bootstrap the initial DARBITEX/APT
        liquidity pool on Darbitex itself.
      </p>
      <p>
        <strong>3. LP staking activation.</strong> Once the liquidity pool exists, LP
        staking reward pools go live with DARBITEX as the reward token. LP providers
        who stake earn DARBITEX. The protocol's own trading fees continuously refill
        the treasury, which continuously funds LP staking rewards.
      </p>

      <h2 className="section-title">Disclaimer</h2>
      <div className="about-disclaimer">
        <p>
          Darbitex is <strong>experimental DeFi software</strong> built entirely by{" "}
          <strong>one human and one AI (Claude, by Anthropic)</strong>. Every smart
          contract, every satellite module, every line of frontend code, and every
          audit submission was produced by this two-person team. The AI-conducted
          audits are{" "}
          <strong>AI-generated reviews, not professional security audits</strong> by
          a licensed firm. They are aids to development, not guarantees of correctness
          or safety.
        </p>
        <p>
          Smart contracts may contain undiscovered bugs. Funds deposited into pools,
          vaults, staking contracts, troves, the ONE stability pool, or any other
          on-chain component <strong>may be lost permanently</strong>.
        </p>
        <p>
          There is{" "}
          <strong>
            no team, no company, no legal entity, no customer support, no insurance
            fund, and no recourse mechanism
          </strong>
          . All code is published under The Unlicense (public domain).
        </p>
        <p>
          <strong>Do not deposit more than you can afford to lose entirely.</strong>{" "}
          Nothing on this site or in this protocol constitutes investment advice.
        </p>
        <p className="mute" style={{ marginTop: 12 }}>
          Use at your own risk. You have been warned.
        </p>
      </div>
    </div>
  );
}
