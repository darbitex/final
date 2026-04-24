import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { WalletProvider } from "./wallet/Provider";

// Lazy routes — each page is its own chunk and its own RPC pool. Pages
// that aren't mounted don't contribute any traffic to the per-IP budget.
const TradePage = lazy(() => import("./pages/Trade").then((m) => ({ default: m.TradePage })));
const ArbitragePage = lazy(() =>
  import("./pages/Arbitrage").then((m) => ({ default: m.ArbitragePage })),
);

const Liquidity = lazy(() => import("./pages/Liquidity").then((m) => ({ default: m.Liquidity })));
const PoolsBody = lazy(() => import("./pages/Pools").then((m) => ({ default: m.PoolsBody })));
const PortfolioBody = lazy(() =>
  import("./pages/Portfolio").then((m) => ({ default: m.PortfolioBody })),
);

const Earn = lazy(() => import("./pages/Earn").then((m) => ({ default: m.Earn })));
const VaultBody = lazy(() => import("./pages/Vault").then((m) => ({ default: m.VaultBody })));
const StakingBody = lazy(() => import("./pages/Staking").then((m) => ({ default: m.StakingBody })));

const Tools = lazy(() => import("./pages/Tools").then((m) => ({ default: m.Tools })));
const FactoryBody = lazy(() =>
  import("./pages/Factory").then((m) => ({ default: m.FactoryBody })),
);
const DisperseBody = lazy(() =>
  import("./pages/Disperse").then((m) => ({ default: m.DisperseBody })),
);

const OneShell = lazy(() => import("./pages/One").then((m) => ({ default: m.OneShell })));
const OneOverview = lazy(() =>
  import("./pages/one/Overview").then((m) => ({ default: m.OneOverview })),
);
const OneTrove = lazy(() => import("./pages/one/Trove").then((m) => ({ default: m.OneTrove })));
const OneSp = lazy(() => import("./pages/one/Sp").then((m) => ({ default: m.OneSp })));
const OneRedeem = lazy(() => import("./pages/one/Redeem").then((m) => ({ default: m.OneRedeem })));
const OneLiquidate = lazy(() =>
  import("./pages/one/Liquidate").then((m) => ({ default: m.OneLiquidate })),
);
const OneAbout = lazy(() =>
  import("./pages/one/About").then((m) => ({ default: m.OneAbout })),
);

const AboutPage = lazy(() => import("./pages/About").then((m) => ({ default: m.AboutPage })));

function PageFallback() {
  return <div className="page-loading">Loading…</div>;
}

function wrap(element: React.ReactElement) {
  return <Suspense fallback={<PageFallback />}>{element}</Suspense>;
}

export function App() {
  return (
    <WalletProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={wrap(<TradePage />)} />
            <Route path="arbitrage" element={wrap(<ArbitragePage />)} />

            <Route path="liquidity" element={wrap(<Liquidity />)}>
              <Route index element={<Navigate to="pools" replace />} />
              <Route path="pools" element={wrap(<PoolsBody />)} />
              <Route path="portfolio" element={wrap(<PortfolioBody />)} />
            </Route>

            <Route path="earn" element={wrap(<Earn />)}>
              <Route index element={<Navigate to="vault" replace />} />
              <Route path="vault" element={wrap(<VaultBody />)} />
              <Route path="staking" element={wrap(<StakingBody />)} />
            </Route>

            <Route path="tools" element={wrap(<Tools />)}>
              <Route index element={<Navigate to="factory" replace />} />
              <Route path="factory" element={wrap(<FactoryBody />)} />
              <Route path="disperse" element={wrap(<DisperseBody />)} />
            </Route>

            <Route path="one" element={wrap(<OneShell />)}>
              <Route index element={wrap(<OneOverview />)} />
              <Route path="trove" element={wrap(<OneTrove />)} />
              <Route path="sp" element={wrap(<OneSp />)} />
              <Route path="redeem" element={wrap(<OneRedeem />)} />
              <Route path="liquidate" element={wrap(<OneLiquidate />)} />
              <Route path="about" element={wrap(<OneAbout />)} />
            </Route>

            <Route path="about" element={wrap(<AboutPage />)} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </WalletProvider>
  );
}
