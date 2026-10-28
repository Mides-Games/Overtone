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

// W12.20: the API's reference carries the whole OpenAPI document, and the
// tokens page is for the few who script: both loaded when opened.
const Developers = lazy(() => import('./pages/Developers.jsx'))
const Tokens = lazy(() => import('./pages/Tokens.jsx'))
const Embed = lazy(() => import('./pages/Embed.jsx'))

const later = (page) => <Suspense fallback={<BrandLoader className="py-16" />}>{page}</Suspense>

export default function App() {
  return (
    <Routes>
      {/* W12.18: a published timing's card for other sites to frame; outside the layout, and the one framable path. */}
      <Route path="embed/:id" element={later(<Embed />)} />
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
        <Route path="developers" element={later(<Developers />)} />
        {/* Self-contained, so the settings page (W12.15) can link to it as it is. */}
        <Route path="settings/tokens" element={later(<Tokens />)} />
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
