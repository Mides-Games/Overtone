import { Suspense, lazy } from 'react'
import { Route, Routes } from 'react-router'

import BrandLoader from './components/BrandLoader.jsx'
import Layout from './components/Layout.jsx'
import AnalysisResult from './pages/AnalysisResult.jsx'
import Analyze from './pages/Analyze.jsx'
import Community from './pages/Community.jsx'
import Compare from './pages/Compare.jsx'
import Faq from './pages/Faq.jsx'
import Glossary from './pages/Glossary.jsx'
import History from './pages/History.jsx'
import Home from './pages/Home.jsx'
import HowItWorks from './pages/HowItWorks.jsx'
import { Disclaimer, Privacy, Terms } from './pages/Legal.jsx'
import Login from './pages/Login.jsx'
import LoginCallback from './pages/LoginCallback.jsx'
import NotFound from './pages/NotFound.jsx'
import OsuLink from './pages/OsuLink.jsx'
import Profile from './pages/Profile.jsx'
import Queue from './pages/Queue.jsx'
import Settings from './pages/Settings.jsx'
import Stats from './pages/Stats.jsx'
import Status from './pages/Status.jsx'

// The credits carry the whole dependency list (src/data/credits.json): loaded
// when someone opens them, not with every page.
const Credits = lazy(() => import('./pages/Credits.jsx'))
import CollectionPage from './pages/CollectionPage.jsx'
import Recent from './pages/Recent.jsx'
import Timers from './pages/Timers.jsx'
import TimingPage from './pages/TimingPage.jsx'
import UserProfile from './pages/UserProfile.jsx'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="analyze" element={<Analyze />} />
        <Route path="analyze/:id" element={<AnalysisResult />} />
        <Route path="queue" element={<Queue />} />
        <Route path="community" element={<Community />} />
        <Route path="recent" element={<Recent />} />
        <Route path="history" element={<History />} />
        {/* Two timings side by side (W12.11): private-ish, its ids in the query; not in the sitemap. */}
        <Route path="compare" element={<Compare />} />
        {/* A published timing's own page (W3.27); deploy/web/serve.mjs writes its link preview. */}
        <Route path="t/:id" element={<TimingPage />} />
        {/* W6 and W13.18: the ranking of timers, a timer's public profile, a collection. */}
        <Route path="timers" element={<Timers />} />
        <Route path="u/:username" element={<UserProfile />} />
        <Route path="c/:id" element={<CollectionPage />} />
        <Route path="login" element={<Login />} />
        {/* The SSO's redirect_uri: SITE_URL + /login/callback, registered with Mides. */}
        <Route path="login/callback" element={<LoginCallback />} />
        <Route path="profile" element={<Profile />} />
        {/* osu!'s OAuth redirect_uri (W9.2): SITE_URL + /link/osu, registered with the osu! app. */}
        <Route path="link/osu" element={<OsuLink />} />
        <Route path="status" element={<Status />} />
        <Route path="settings" element={<Settings />} />
        <Route path="stats" element={<Stats />} />
        <Route path="how-it-works" element={<HowItWorks />} />
        <Route path="faq" element={<Faq />} />
        <Route path="glossary" element={<Glossary />} />
        <Route path="terms" element={<Terms />} />
        <Route path="privacy" element={<Privacy />} />
        <Route path="disclaimer" element={<Disclaimer />} />
        <Route
          path="credits"
          element={
            <Suspense fallback={<BrandLoader className="py-16" />}>
              <Credits />
            </Suspense>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
