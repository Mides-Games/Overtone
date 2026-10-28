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
const CollectionPage = lazy(() => import('./pages/CollectionPage.jsx'))
const Community = lazy(() => import('./pages/Community.jsx'))
const Calculator = lazy(() => import('./pages/Calculator.jsx'))
const Compare = lazy(() => import('./pages/Compare.jsx'))
const Credits = lazy(() => import('./pages/Credits.jsx'))
// W12.20: the API's reference carries the whole OpenAPI document, and the
// tokens page is for the few who script.
const Developers = lazy(() => import('./pages/Developers.jsx'))
const Embed = lazy(() => import('./pages/Embed.jsx'))
const Faq = lazy(() => import('./pages/Faq.jsx'))
const Glossary = lazy(() => import('./pages/Glossary.jsx'))
const History = lazy(() => import('./pages/History.jsx'))
const HowItWorks = lazy(() => import('./pages/HowItWorks.jsx'))
const Login = lazy(() => import('./pages/Login.jsx'))
const LoginCallback = lazy(() => import('./pages/LoginCallback.jsx'))
const Notifications = lazy(() => import('./pages/Notifications.jsx'))
const OsuLink = lazy(() => import('./pages/OsuLink.jsx'))
const Profile = lazy(() => import('./pages/Profile.jsx'))
const Queue = lazy(() => import('./pages/Queue.jsx'))
const Recent = lazy(() => import('./pages/Recent.jsx'))
const Settings = lazy(() => import('./pages/Settings.jsx'))
const Staff = lazy(() => import('./pages/Staff.jsx'))
const Stats = lazy(() => import('./pages/Stats.jsx'))
const Status = lazy(() => import('./pages/Status.jsx'))
// W13.12: the microphone tool; its worklet and the spectral worker load with it.
const TapMic = lazy(() => import('./pages/TapMic.jsx'))
const Timers = lazy(() => import('./pages/Timers.jsx'))
const TimingPage = lazy(() => import('./pages/TimingPage.jsx'))
const Tokens = lazy(() => import('./pages/Tokens.jsx'))
const UserProfile = lazy(() => import('./pages/UserProfile.jsx'))
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
      {/* W12.18: a published timing's card for other sites to frame; outside the layout, and the one framable path. */}
      <Route path="embed/:id" element={page(Embed)} />
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
        {/* W6 and W13.18: the ranking of timers, a timer's public profile, a collection. */}
        <Route path="timers" element={page(Timers)} />
        <Route path="u/:username" element={page(UserProfile)} />
        <Route path="c/:id" element={page(CollectionPage)} />
        <Route path="login" element={page(Login)} />
        {/* The SSO's redirect_uri: SITE_URL + /login/callback, registered with Mides. */}
        <Route path="login/callback" element={page(LoginCallback)} />
        <Route path="profile" element={page(Profile)} />
        {/* osu!'s OAuth redirect_uri (W9.2): SITE_URL + /link/osu, registered with the osu! app. */}
        <Route path="link/osu" element={page(OsuLink)} />
        <Route path="status" element={page(Status)} />
        <Route path="developers" element={page(Developers)} />
        {/* Self-contained, so the settings page (W12.15) can link to it as it is. */}
        <Route path="settings/tokens" element={page(Tokens)} />
        <Route path="settings" element={page(Settings)} />
        {/* W13.17 and W13.19: an account's notifications, and the staff panel (a 404 for anyone else). Private. */}
        <Route path="notifications" element={page(Notifications)} />
        <Route path="staff" element={page(Staff)} />
        <Route path="stats" element={page(Stats)} />
        <Route path="how-it-works" element={page(HowItWorks)} />
        <Route path="faq" element={page(Faq)} />
        <Route path="glossary" element={page(Glossary)} />
        <Route path="tools/tap-mic" element={page(TapMic)} />
        <Route path="tools/calculator" element={page(Calculator)} />
        <Route path="terms" element={page(Terms)} />
        <Route path="privacy" element={page(Privacy)} />
        <Route path="disclaimer" element={page(Disclaimer)} />
        <Route path="credits" element={page(Credits)} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
