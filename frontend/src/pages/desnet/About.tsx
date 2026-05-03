import {
  DESNET_AMM_POOL,
  DESNET_APT_VAULT,
  DESNET_FA,
  DESNET_FIRST_OPINION_MARKET,
  DESNET_LP_EMISSION_RESERVE,
  DESNET_LP_STAKING_POOL,
  DESNET_ORIGIN_MULTISIG,
  DESNET_PACKAGE,
  DESNET_PID_NFT,
  DESNET_REACTION_EMISSION_RESERVE,
} from "../../config";
import { shortAddr } from "../../chain/desnet/format";

const VERBS = [
  ["Mint", "mint", "Original post (text ≤333 B + media), optionally with opinion market"],
  ["Spark", "pulse", "Like / positive reaction"],
  ["Voice", "mint", "Reply (parent set)"],
  ["Echo", "pulse", "Repost / amplify"],
  ["Remix", "mint", "Quote-post (quote set)"],
  ["Press", "press", "Mint a Mint as a collectible NFT"],
  ["Sync", "link", "Subscribe to a PID's mints"],
  ["Opinion", "opinion", "Trade YAY/NAY belief on an opinion-mint"],
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
  ["First opinion market (MAGA)", DESNET_FIRST_OPINION_MARKET],
];

export function About() {
  return (
    <div className="card about-card">
      <h2>About DeSNet</h2>
      <p>
        A decentralized social network protocol on Aptos. Every profile is an
        Object NFT, every profile spawns its own fungible token, and every
        social action — posts, likes, replies, quotes, presses, syncs,{" "}
        <strong>opinions</strong> — is an on-chain primitive.
      </p>
      <p>
        No centralized backend. No off-chain database. No oracle. No expiry.
        No protocol fees on swaps.
      </p>
      <p>
        <strong>Status:</strong> v0.4 live on Aptos mainnet
        (<code>{shortAddr(DESNET_PACKAGE)}</code>). 19 Move modules, ~10.6k
        LoC. Audited across seven external review rounds (R1 → R7) and four
        parallel pre-deploy paranoid agents.
      </p>
      <p className="muted small">
        The R1–R7 verdicts cover the on-chain Move package only. This frontend
        ships its own self-audit pass and is not part of the external panel.
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

      <h3>What's new in v0.4</h3>
      <p>
        Two strictly compat-additive feature lines, deployed via 3/5 multisig
        chunked upgrade on 2026-05-04 (upgrade_number 5 → 6):
      </p>
      <ul>
        <li>
          <strong>Opinion pool</strong> (<code>desnet::opinion</code>, 1.7k
          LoC) — perpetual no-settle prediction-market substrate attached to
          mints. Belief expressed as price, never resolved, always tradable.
        </li>
        <li>
          <strong>Assets multi-tier</strong> (<code>desnet::assets</code>{" "}
          Tier-2 / Tier-3) — fractal-tree on-chain media uploads with
          deterministic-address chunks for parallel JS-pre-computed deploys.
        </li>
        <li>
          <code>mint::create_opinion_mint</code> — single new entry, one user
          click, one tx: regular mint plus atomic opinion-market bootstrap.
        </li>
      </ul>
      <p className="muted small">
        Compat: <code>mint::create_mint</code> signature byte-identical to
        v0.3.3, <code>MintEvent</code> BCS layout unchanged. Opinion-mints are
        detected via the <code>opinion::market_exists</code> view — v0.3.3
        indexers continue working unchanged.
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
      <p>
        The PID is the unit of identity, the token is the unit of
        speech-economy, the AMM pool is the price discovery surface, and — as
        of v0.4 — every mint can carry an{" "}
        <strong>always-open belief market</strong> denominated in its author's
        own token. All bound together at registration in a single transaction.
      </p>

      <h3>The eight verbs</h3>
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
        Posts can carry tags (ownerless folksonomy, lowercase{" "}
        <code>[a-z0-9-]</code>), tickers (factory-spawned <code>$X</code> only
        — every ticker resolves to a PID), mentions (any Aptos address), and
        tips (any FA-standard token). Pressing a Mint distributes a
        linear-curve emission from that token's reaction reserve to the
        presser. Trading on an opinion-mint moves price within a{" "}
        <code>x*y=k</code> curve denominated in the author's own creator-token,
        with a 0.1% tax burned from that same token on every interaction.
      </p>

      <h3>The opinion market — what makes it elegant</h3>
      <p>
        Most on-chain prediction markets need an <em>oracle</em>, an{" "}
        <em>expiry</em>, and a <em>resolution event</em>. The opinion pool
        needs none of them. It is built around a single observation: if the
        price of a YAY share is the market's confidence in a claim, then the
        price <em>is</em> the resolution. Resolving forecloses; not resolving
        keeps belief liquid forever.
      </p>
      <p>
        The mechanism is the simplest CPMM you can write —{" "}
        <code>x &times; y = k</code> — applied to four design choices that
        compound into something useful:
      </p>
      <ol>
        <li>
          <strong>Mirror-Mint Bootstrap.</strong> At creation, the author
          commits <code>initial_mc</code> of their own factory token. Vault
          receives <code>initial_mc</code> creator-token, both pool sides
          receive <code>initial_mc</code> YAY/NAY each, the creator keeps zero
          position. The pool is active on block zero, symmetric, no founder
          advantage.
        </li>
        <li>
          <strong>Creator-token denomination.</strong> Collateral and tax are
          both denominated in <code>$creator_token</code>, never APT, never
          USD. Skin in the game. Spam is self-defeating (frivolous markets are
          penalized in the issuer's own currency). Trade volume is{" "}
          <em>deflationary</em> for the author — every swap burns 0.1% of the
          spot-equivalent <code>$creator_token</code>.
        </li>
        <li>
          <strong>Conservation as the only invariant.</strong> The contract
          asserts at every mutation:{" "}
          <code>vault_balance == supply(YAY) == supply(NAY)</code>. Pool
          reserves can swing arbitrarily; total YAY equals total NAY equals
          collateral always. Always-exit is mathematical, not contractual:
          anyone holding (N YAY, N NAY) can{" "}
          <code>redeem_complete_set(N)</code> for N collateral minus tax skim.
        </li>
        <li>
          <strong>Compat-safe detection.</strong> Opinion-mints emit the same{" "}
          <code>MintEvent</code> as any other mint. There is no{" "}
          <code>is_opinion</code> field. Indexers distinguish via the pure
          view <code>opinion::market_exists(author_pid, seq)</code> — v0.3.3
          indexers continue working unchanged, v0.4 indexers add one extra
          view call per mint to classify them.
        </li>
      </ol>
      <p>
        Because opinion-mints <strong>are</strong> mints, every other DeSNet
        primitive applies natively: press an opinion-mint into a collectible
        NFT, sync to receive opinion-mints in your feed, voice (reply) on an
        opinion-mint, remix (quote) it, spark/echo it, tip the author. The
        opinion AMM is not a new app — it is an extra dimension of one
        feature: belief-as-price layered onto the existing post primitive.
      </p>
      <p className="muted small">
        What the design refuses: no oracle, no expiry, no resolution
        committee, no virtual reserves, no time decay, no LP shares. The
        creator's <code>initial_mc</code> is escrowed permanently as
        always-redeemable collateral. The "fee" is the tax burn; recipients
        are all <code>$creator_token</code> holders, by deflation.
      </p>

      <h3>Assets multi-tier — three doors, frontend chooses</h3>
      <p>
        Mint events embed media via <code>MintMedia</code>. For media &gt;8 KB,
        the asset module stores binary blobs as a fractal tree of 30 KB
        chunks, up to 5 MB total. The orchestrator{" "}
        (<code>orchestrator_tier()</code> returns <code>3</code> on mainnet)
        exposes three address-allocation strategies:
      </p>
      <ul>
        <li>
          <strong>Tier 1</strong> — server allocates the Object addr at{" "}
          <code>start_upload</code>; caller queries it back. Simple sequential
          uploader.
        </li>
        <li>
          <strong>Tier 2 (<code>*_pub</code>)</strong> — same as Tier 1 but
          the entry returns the addr explicitly. Move scripts can chain{" "}
          <code>start_upload → deploy_chunk</code> in one tx.
        </li>
        <li>
          <strong>Tier 3 (<code>*_v2</code>)</strong> — deterministic addr
          from <code>(uploader, master_nonce, chunk_index)</code> via sha3 +{" "}
          <code>create_named_object</code>. Frontend can pre-compute every
          chunk address in JS before any tx fires; supports parallel chunk
          uploads + retry-with-known-addr.
        </li>
      </ul>

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
        <strong>Opinion markets</strong> layer additional deflation onto
        creator-tokens: every trade on an opinion-mint burns 0.1% of the
        spot-equivalent <code>$creator_token</code>. Successful debate
        produces volume; volume produces burn. There is no protocol skim.
      </p>
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

      <h3>Audit</h3>
      <p>
        External multi-LLM audit panel across seven rounds (R1 → R7).
      </p>
      <ul>
        <li>
          <strong>R6 (v0.3.3)</strong> — 5 GREEN / 1 YELLOW (Q-H1 disputed →
          REJECTED on 5/6 consensus). Reviewers: Gemini 3.1 Pro, DeepSeek V3.2,
          Grok 4 (xAI), Claude Opus 4.7, Kimi K2.6, Qwen 3 Max.
        </li>
        <li>
          <strong>R7 (v0.4 opinion + assets multi-tier)</strong> — 5 GREEN /
          1 YELLOW. 0 unfixed HIGH.
        </li>
        <li>
          <strong>Pre-deploy paranoid (v0.4)</strong> — 4 / 4 GREEN
          (compat/ABI, atomicity/auth, friend-graph, state-invariant agents in
          parallel). rc4 fix bundle applied (M1 sym{" "}
          <code>E_ZERO_OUTPUT</code>, L1 <code>E_TAX_DRIFT</code>, L2{" "}
          <code>E_MARKET_ALREADY_EXISTS</code>).
        </li>
        <li>Tests: <strong>113/113 GREEN</strong>.</li>
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
        <li><strong>Belief is liquid; resolution forecloses.</strong> Opinion markets have no oracle, no expiry, no settlement. Price is the verdict.</li>
        <li><strong>No protocol fees on swaps.</strong> AMM fee 10 bps, 100% to LP. Opinion tax 10 bps, 100% burned. Protocol revenue comes only from handle registration.</li>
        <li><strong>No off-chain dependencies for core flows.</strong> Posts, media, history, opinion markets — all on-chain. Frontend is a renderer, not a backend.</li>
        <li><strong>Tickers are scarce by design.</strong> Every <code>$X</code> ticker resolves to a PID. No anonymous launchpads.</li>
        <li><strong>Tags are ownerless.</strong> Folksonomy permanently — no namespace landgrab.</li>
        <li><strong>Forever-lock the creator LP.</strong> No rug surface. The creator earns from emissions and fees, not from extraction.</li>
        <li><strong>Conservation is asserted, not assumed.</strong> Every opinion mutation re-checks <code>vault == total_yay_supply == total_nay_supply</code> against framework state.</li>
        <li><strong>Compat-safe upgrades.</strong> v0.4 added a 1.7k LoC module without touching <code>MintEvent</code>'s BCS layout. Indexers continue to work unchanged.</li>
        <li><strong>F7 cross-token inflation defense.</strong> Voting power isolates per-token rewards.</li>
        <li><strong>MEV-safe settle.</strong> Commit-reveal with 60 s delay and 5% slippage cap.</li>
        <li><strong>Source digest pinned off-chain.</strong> Final-chunk publish aborts if assembled <code>(metadata, code)</code> digest doesn't match the pre-shared expected digest.</li>
      </ul>

      <h3>Versions</h3>
      <ul>
        <li><strong>v0.4</strong> — current mainnet. R7 audit 5/6 GREEN + 4/4 paranoid agents GREEN. Adds opinion + assets multi-tier. Tag <code>v0.4-mainnet-live</code>.</li>
        <li><strong>v0.3.3</strong> — superseded by v0.4. R6 audit 5/6 GREEN.</li>
        <li><strong>v0.3.2</strong> — superseded. Introduced two-phase settle infra and per-token voter history.</li>
        <li><strong>v0.3.1</strong> — superseded. Added <code>handle_fee_vault</code> (initial 50/50 split, later changed to 10/90).</li>
        <li><strong>v0.3.0</strong> — initial mainnet.</li>
      </ul>
    </div>
  );
}
