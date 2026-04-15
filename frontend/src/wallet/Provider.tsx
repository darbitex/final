import { AptosWalletAdapterProvider } from "@aptos-labs/wallet-adapter-react";
import { Network } from "@aptos-labs/ts-sdk";
import type { ReactNode } from "react";

export function WalletProvider({ children }: { children: ReactNode }) {
  return (
    <AptosWalletAdapterProvider
      autoConnect
      optInWallets={[
        "Petra",
        "Continue with Google",
        "Continue with Apple",
        "Petra Web",
        "OKX Wallet",
        "Nightly",
      ]}
      dappConfig={{
        network: Network.MAINNET,
        aptosConnect: { dappName: "Darbitex" },
      }}
      onError={(err) => {
        console.error("wallet error", err);
      }}
    >
      {children}
    </AptosWalletAdapterProvider>
  );
}
