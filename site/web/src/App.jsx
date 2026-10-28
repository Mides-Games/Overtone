import { Suspense, lazy } from 'react'
import { Route, Routes } from 'react-router'

import BrandLoader from './components/BrandLoader.jsx'
import Layout from './components/Layout.jsx'
import Home from './pages/Home.jsx'
import NotFound from './pages/NotFound.jsx'

/*
 * Every page but the home page and the 404 is its own chunk (W10.1), loaded
 * when someone opens it: a first visit downloads the frame and the home page,
 * not the tempo map, the player, the exports, the tag reader or the community.
 * The two kept eager are the likeliest first paint and the page that must
 * never wait on a network that just failed. The routes' chunks and their
 * budgets are in scripts/budget.mjs.
 */
const AnalysisResult = lazy(() => import('./pages/AnalysisResult.jsx'))
const Analyze = lazy(() => import('./pages/Analyze.jsx'))
const Community = lazy(() => import('./pages/Community.jsx'))
const Compare = lazy(() => import('./pages/Compare.jsx'))
const Credits = lazy(() => import('./pages/Credits.jsx'))
const Faq = lazy(() => import('./pages/Faq.jsx'))
const Glossary = lazy(() => import('./pages/Glossary.jsx'))
const History = lazy(() => import('./pages/History.jsx'))
const HowItWorks = lazy(() => import('./pages/HowItWorks.jsx'))
const Login = lazy(() => import('./pages/Login.jsx'))
const LoginCallback = lazy(() => import('./pages/LoginCallback.jsx'))
const Profile = lazy(() => import('./pages/Profile.jsx'))
const Queue = lazy(() => import('./pages/Queue.jsx'))
const Recent = lazy(() => import('./pages/Recent.jsx'))
const Settings = lazy(() => import('./pages/Settings.jsx'))
const Stats = lazy(() => import('./pages/Stats.jsx'))
const Status = lazy(() => import('./pages/Status.jsx'))
const TimingPage = lazy(() => import('./pages/TimingPage.jsx'))
const legal = () => import('./pages/Legal.jsx')
const Terms = lazy(() => legal().then((m) => ({ default: m.Terms })))
const Privacy = lazy(() => legal().then((m) => ({ default: m.Privacy })))
const Disclaimer = lazy(() => legal().then((m) => ({ default: m.Disclaimer })))

/** A lazy page, with the brand loader while its chunk arrives. */
const page = (Page) => (
  <Suspense fallback={<BrandLoader className="py-16" />}>
    <Page />
  </Suspense>
)

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="analyze" element={page(Analyze)} />
        <Route path="analyze/:id" element={page(AnalysisResult)} />
        <Route path="queue" element={page(Queue)} />
        <Route path="community" element={page(Community)} />
        <Route path="recent" element={page(Recent)} />
        <Route path="history" element={page(History)} />
        {/* Two timings side by side (W12.11): private-ish, its ids in the query; not in the sitemap. */}
        <Route path="compare" element={page(Compare)} />
        {/* A published timing's own page (W3.27); deploy/web/serve.mjs writes its link preview. */}
        <Route path="t/:id" element={page(TimingPage)} />
        <Route path="login" element={page(Login)} />
        {/* The SSO's redirect_uri: SITE_URL + /login/callback, registered with Mides. */}
        <Route path="login/callback" element={page(LoginCallback)} />
        <Route path="profile" element={page(Profile)} />
        <Route path="status" element={page(Status)} />
        <Route path="settings" element={page(Settings)} />
        <Route path="stats" element={page(Stats)} />
        <Route path="how-it-works" element={page(HowItWorks)} />
        <Route path="faq" element={page(Faq)} />
        <Route path="glossary" element={page(Glossary)} />
        <Route path="terms" element={page(Terms)} />
        <Route path="privacy" element={page(Privacy)} />
        <Route path="disclaimer" element={page(Disclaimer)} />
        <Route path="credits" element={page(Credits)} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
