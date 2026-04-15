import { useEffect, useState } from "react";
import { TOKENS, type TokenConfig } from "../config";
import { createRpcPool, fromRaw } from "../chain/rpc-pool";
import { useAddress } from "../wallet/useConnect";

const rpc = createRpcPool("portfolio");

type BalanceRow = {
  token: TokenConfig;
  raw: bigint;
  error?: string;
};

export function PortfolioPage() {
  const address = useAddress();
  const [rows, setRows] = useState<BalanceRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!address) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);

    (async () => {
      const tokenList = Object.values(TOKENS);
      const results = await Promise.all(
        tokenList.map(async (token) => {
          try {
            const balances = await rpc.primary.getCurrentFungibleAssetBalances({
              options: {
                where: {
                  owner_address: { _eq: address },
                  asset_type: { _eq: token.meta },
                },
              },
            });
            const amount = balances[0]?.amount ?? 0;
            return { token, raw: BigInt(amount) };
          } catch (e) {
            return { token, raw: 0n, error: (e as Error).message };
          }
        }),
      );
      if (cancelled) return;
      setRows(results);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [address]);

  if (!address) {
    return (
      <div className="container">
        <h1 className="page-title">Portfolio</h1>
        <p className="page-sub">Connect your wallet to view balances and LP positions.</p>
      </div>
    );
  }

  return (
    <div className="container">
      <h1 className="page-title">Portfolio</h1>
      <p className="page-sub">
        Balances for tracked tokens. LP positions are Aptos objects — view them on the
        Explorer under your account's digital assets.
      </p>

      <div className="portfolio-addr">
        <span className="dim">Wallet</span>
        <code>
          {address.slice(0, 10)}…{address.slice(-6)}
        </code>
      </div>

      <div className="pool-table">
        <div className="pool-head">
          <span>Token</span>
          <span>Address</span>
          <span>Balance</span>
        </div>
        {loading && rows.length === 0 && <div className="hint">Loading…</div>}
        {rows.map((r) => (
          <div key={r.token.meta} className="pool-row">
            <span className="pair">{r.token.symbol}</span>
            <span className="addr-short">
              <a
                href={`https://explorer.aptoslabs.com/fungible_asset/${r.token.meta}?network=mainnet`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {r.token.meta.slice(0, 10)}…{r.token.meta.slice(-4)}
              </a>
            </span>
            <span className="reserves">
              {r.error ? "error" : fromRaw(r.raw, r.token.decimals).toFixed(6)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
