import { useEffect, useState } from "react";
import { fetchFaMetadata } from "../balance";
import { TOKENS } from "../../config";

export type TokenView = {
  symbol: string;
  /// Either a bundled relative path (`/tokens/...`) or an on-chain `icon_uri`.
  /// The TokenIcon component falls back to a letter badge if the URL fails to load.
  icon?: string;
};

const APT_TOKEN: TokenView = { symbol: "APT", icon: "/tokens/apt.svg" };

/// Resolve a $TOKEN view from its FA metadata addr. First checks the bundled
/// TOKENS whitelist (so DESNET, DARBITEX, USDC etc. always render their
/// curated SVGs), then falls back to the on-chain `Metadata.icon_uri` set
/// by the token's creator at register_handle time.
export function useTokenView(metaAddr: string | null): TokenView {
  const [view, setView] = useState<TokenView>({ symbol: "?", icon: undefined });

  useEffect(() => {
    let cancelled = false;
    if (!metaAddr) {
      setView({ symbol: "?" });
      return;
    }

    // 1. Bundled whitelist
    const lower = metaAddr.toLowerCase();
    const hit = Object.values(TOKENS).find((t) => t.meta.toLowerCase() === lower);
    if (hit) {
      setView({ symbol: hit.symbol, icon: hit.icon });
      return;
    }

    // 2. On-chain metadata — uses the cached fetcher so repeated lookups are
    //    free after the first round-trip.
    fetchFaMetadata(metaAddr).then((m) => {
      if (cancelled || !m) return;
      setView({ symbol: m.symbol, icon: m.iconUri });
    });

    return () => {
      cancelled = true;
    };
  }, [metaAddr]);

  return view;
}

export const APT_VIEW = APT_TOKEN;
