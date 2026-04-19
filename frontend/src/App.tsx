import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { WalletProvider } from "./wallet/Provider";

// Lazy routes — each page is its own chunk and its own RPC pool. Pages
// that aren't mounted don't contribute any traffic to the per-IP budget.
const SwapPage = lazy(() => import("./pages/Swap").then((m) => ({ default: m.SwapPage })));
const AggregatorPage = lazy(() =>
  import("./pages/Aggregator").then((m) => ({ default: m.AggregatorPage })),
);
const ArbitragePage = lazy(() =>
  import("./pages/Arbitrage").then((m) => ({ default: m.ArbitragePage })),
);
const PoolsPage = lazy(() => import("./pages/Pools").then((m) => ({ default: m.PoolsPage })));
const PortfolioPage = lazy(() =>
  import("./pages/Portfolio").then((m) => ({ default: m.PortfolioPage })),
);
const ProtocolPage = lazy(() =>
  import("./pages/Protocol").then((m) => ({ default: m.ProtocolPage })),
);
const FactoryPage = lazy(() =>
  import("./pages/Factory").then((m) => ({ default: m.FactoryPage })),
);
const VaultPage = lazy(() => import("./pages/Vault").then((m) => ({ default: m.VaultPage })));
const StakingPage = lazy(() => import("./pages/Staking").then((m) => ({ default: m.StakingPage })));
const DispersePage = lazy(() => import("./pages/Disperse").then((m) => ({ default: m.DispersePage })));
const AboutPage = lazy(() => import("./pages/About").then((m) => ({ default: m.AboutPage })));

function PageFallback() {
  return <div className="page-loading">Loading…</div>;
}

export function App() {
  return (
    <WalletProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route
              index
              element={
                <Suspense fallback={<PageFallback />}>
                  <SwapPage />
                </Suspense>
              }
            />
            <Route
              path="aggregator"
              element={
                <Suspense fallback={<PageFallback />}>
                  <AggregatorPage />
                </Suspense>
              }
            />
            <Route
              path="arbitrage"
              element={
                <Suspense fallback={<PageFallback />}>
                  <ArbitragePage />
                </Suspense>
              }
            />
            <Route
              path="pools"
              element={
                <Suspense fallback={<PageFallback />}>
                  <PoolsPage />
                </Suspense>
              }
            />
            <Route
              path="portfolio"
              element={
                <Suspense fallback={<PageFallback />}>
                  <PortfolioPage />
                </Suspense>
              }
            />
            <Route
              path="factory"
              element={
                <Suspense fallback={<PageFallback />}>
                  <FactoryPage />
                </Suspense>
              }
            />
            <Route
              path="vault"
              element={
                <Suspense fallback={<PageFallback />}>
                  <VaultPage />
                </Suspense>
              }
            />
            <Route
              path="staking"
              element={
                <Suspense fallback={<PageFallback />}>
                  <StakingPage />
                </Suspense>
              }
            />
            <Route
              path="disperse"
              element={
                <Suspense fallback={<PageFallback />}>
                  <DispersePage />
                </Suspense>
              }
            />
            <Route
              path="protocol"
              element={
                <Suspense fallback={<PageFallback />}>
                  <ProtocolPage />
                </Suspense>
              }
            />
            <Route
              path="about"
              element={
                <Suspense fallback={<PageFallback />}>
                  <AboutPage />
                </Suspense>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </WalletProvider>
  );
}
