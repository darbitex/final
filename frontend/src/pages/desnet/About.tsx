import {
  DESNET_AMM_POOL,
  DESNET_APT_VAULT,
  DESNET_FA,
  DESNET_LP_EMISSION_RESERVE,
  DESNET_LP_STAKING_POOL,
  DESNET_ORIGIN_MULTISIG,
  DESNET_PACKAGE,
  DESNET_PID_NFT,
  DESNET_REACTION_EMISSION_RESERVE,
} from "../../config";
import { shortAddr } from "../../chain/desnet/format";

const VERBS = [
  ["Mint", "mint", "Original post (text ≤333 B + media)"],
  ["Spark", "pulse", "Like / positive reaction"],
  ["Voice", "mint", "Reply (parent set)"],
  ["Echo", "pulse", "Repost / amplify"],
  ["Remix", "mint", "Quote-post (quote set)"],
  ["Press", "press", "Mint a Mint as a collectible NFT"],
  ["Sync", "link", "Subscribe to a PID's mints"],
] as const;

const ADDRESSES: [string, string, string?][] = [
  ["Package @desnet", DESNET_PACKAGE, "modules/code/profile"],
  ["@origin multisig", DESNET_ORIGIN_MULTISIG],
  ["DESNET PID NFT", DESNET_PID_NFT],
  ["DESNET FA", DESNET_FA],
  ["DESNET AMM pool", DESNET_AMM_POOL],
  ["LP staking pool", DESNET_LP_STAKING_POOL],
  ["LP emission reserve", DESNET_LP_EMISSION_RESERVE],
  ["Reaction emission reserve", DESNET_REACTION_EMISSION_RESERVE],
  ["APT vault (DESNET)", DESNET_APT_VAULT],
];

export function About() {
  return (
    <div className="card about-card">
      <h2>About DeSNet</h2>
      <p>
        A decentralized social network protocol on Aptos. Every profile is an
        Object NFT, every profile spawns its own fungible token, and every
        social action — posts, likes, replies, quotes, presses, syncs — is an
        on-chain primitive. No centralized backend, no off-chain database, no
        protocol fees on swaps.
      </p>
      <p>
        <strong>Status:</strong> v0.3.3 live on Aptos mainnet
        (<code>{shortAddr(DESNET_PACKAGE)}</code>). 18 Move modules, ~8.9k LoC,
        audited by a 6-LLM panel (5 GREEN / 1 YELLOW disputed-and-rejected).
      </p>
      <p>
        <strong>License:</strong>{" "}
        <a
          href={`https://explorer.aptoslabs.com/account/${DESNET_PACKAGE}/modules?network=mainnet`}
          target="_blank"
          rel="noopener noreferrer"
        >
          Unlicense (public domain)
        </a>
        .
      </p>

      <h3>What it is</h3>
      <p>
        A profile (PID) on DeSNet is a transferable Object NFT with a
        deterministic address derived from its owner wallet. Registering a
        handle (<code>alice</code>, <code>bob</code>, <code>desnet</code>, …)
        atomically:
      </p>
      <ol>
        <li>Mints the PID Object NFT to the registrant</li>
        <li>Spawns a per-profile fungible token <code>$ALICE</code> (1B supply, 8 decimals)</li>
        <li>
          Creates an APT/<code>$ALICE</code> AMM pool seeded with 5 APT + 50M
          tokens (FDV ≈ 100 APT)
        </li>
        <li>Locks the creator's LP position permanently into the staking pool</li>
        <li>Splits the handle fee 10% to the deployer / 90% into APT → DESNET buyback-burn</li>
      </ol>
      <p>
        Handle pricing scales by length: 1-char = 100 APT, 6+ chars = 1 APT.
        One-time, immutable, no renewal.
      </p>

      <h3>The seven verbs</h3>
      <table className="about-table">
        <thead>
          <tr>
            <th>Verb</th>
            <th>Module</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          {VERBS.map(([v, m, d]) => (
            <tr key={v}>
              <td><strong>{v}</strong></td>
              <td><code>{m}</code></td>
              <td>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        Posts can carry tags (ownerless folksonomy), tickers (factory-spawned
        $X only — every ticker resolves to a PID), mentions (any Aptos address),
        and tips (any FA-standard token). Pressing a Mint distributes a
        linear-curve emission from that token's reaction reserve to the
        presser.
      </p>

      <h3>Where the value flows</h3>
      <p>
        <strong>DESNET (the protocol token).</strong> Registered as the{" "}
        <code>desnet</code> handle. Receives 90% of every handle-registration
        fee as a buyback-and-burn: APT → AMM swap → burn. Two-phase
        commit-reveal (<code>request_settle</code> → 60 s delay →{" "}
        <code>execute_settle</code>) defends against MEV. Every settle is
        permissionless and every burn is a permanent supply reduction. v0.3.2
        first burn: 3,685,451 DESNET (-0.37% supply on a single 0.9 APT settle).
      </p>
      <p>
        <strong>Per-profile tokens.</strong> 1B supply at mint, allocated:
      </p>
      <ul>
        <li>5% (50M) seeded into the AMM pool</li>
        <li>5% (50M) into the reaction emission reserve (drained as Press distributes)</li>
        <li>90% (900M) into the LP emission reserve (drained as LP stakers claim)</li>
        <li>Creator allocation: 0% (forever-locked LP position is the stake)</li>
      </ul>
      <p>
        <strong>LP staking.</strong> V3-style position NFTs. Two stake kinds —{" "}
        <em>locked</em> (atomic at register, the creator's seed LP, never
        withdrawable) and <em>free</em> (anyone can add, withdrawable). Both
        feed <code>voter_history</code> for governance weight and{" "}
        <code>reference_gate</code> for engagement gating.
      </p>

      <h3>Governance</h3>
      <p>
        Single DAO over the monolith package. Voting power = a voter's
        cumulative DESNET-denominated LP rewards (per-token isolated, with a
        transitional fallback to legacy mixed reads for pre-v0.3.2 voters).
        Chunked package upgrades stage modules into a{" "}
        <code>DaoUpgradeStaging</code> resource via{" "}
        <code>dao_stage_chunks_into_staging</code>, then publish atomically via{" "}
        <code>dao_publish_chunked_upgrade</code> with hash-pin verification.
        Multisig 3/5 on <code>@origin</code> for the bootstrap publisher path.
      </p>

      <h3>Audit (R6)</h3>
      <p>External multi-LLM audit panel across six rounds (R1 → R6). v0.3.3 R6 verdict: <strong>5 GREEN / 1 YELLOW</strong>.</p>
      <ul>
        <li>Gemini 3.1 Pro — GREEN. <em>"definitive and required fix" on settle MEV</em></li>
        <li>DeepSeek V3.2 — GREEN. <em>"Proceed with chunked mainnet deploy"</em></li>
        <li>Grok 4 (xAI) — GREEN. <em>"Deploy v0.3.3. Production ready."</em></li>
        <li>Claude Opus 4.7 — GREEN. <em>6 LOW/INFO findings for v0.3.4 backlog</em></li>
        <li>Kimi K2.6 — GREEN. <em>"no latent HIGH or MED" sweep</em></li>
        <li>Qwen 3 Max — YELLOW. <em>Q-H1 disputed → REJECTED on 5/6 consensus</em></li>
      </ul>

      <h3>Mainnet addresses</h3>
      <table className="about-table">
        <tbody>
          {ADDRESSES.map(([label, addr, suffix]) => (
            <tr key={label}>
              <td>{label}</td>
              <td>
                <a
                  className="mono"
                  href={
                    suffix
                      ? `https://explorer.aptoslabs.com/account/${addr}/${suffix}?network=mainnet`
                      : `https://explorer.aptoslabs.com/account/${addr}?network=mainnet`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {shortAddr(addr)}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Design philosophy</h3>
      <ul>
        <li><strong>One PID, one token, one pool, one tx.</strong> Identity, currency, and market are inseparable.</li>
        <li><strong>No protocol fees on swaps.</strong> AMM fee 10 bps, 100% to LP. Protocol revenue comes only from handle registration.</li>
        <li><strong>No off-chain dependencies for core flows.</strong> Posts, media, history — all on-chain. Frontend is a renderer, not a backend.</li>
        <li><strong>Tickers are scarce by design.</strong> Every <code>$X</code> ticker resolves to a PID. No anonymous launchpads.</li>
        <li><strong>Tags are ownerless.</strong> Folksonomy permanently — no namespace landgrab.</li>
        <li><strong>Forever-lock the creator LP.</strong> No rug surface. The creator earns from emissions and fees, not from extraction.</li>
        <li><strong>F7 cross-token inflation defense.</strong> Voting power isolates per-token rewards; legacy mixed reads only as a pre-v0.3.2 transition fallback.</li>
        <li><strong>MEV-safe settle.</strong> Commit-reveal with 60 s delay and 5% slippage cap. Snapshot amounts pin against vault growth between request and execute.</li>
      </ul>

      <h3>Versions</h3>
      <ul>
        <li><strong>v0.3.3</strong> — current mainnet. R6 audit 5/6 GREEN. Tag <code>v0.3.3-mainnet-live</code>.</li>
        <li><strong>v0.3.2</strong> — superseded. Introduced two-phase settle infra and per-token voter history.</li>
        <li><strong>v0.3.1</strong> — superseded. Added <code>handle_fee_vault</code> (initial 50/50 split, later changed to 10/90).</li>
        <li><strong>v0.3.0</strong> — initial mainnet.</li>
      </ul>
    </div>
  );
}

// shortAddr moved to chain/desnet/format.ts
