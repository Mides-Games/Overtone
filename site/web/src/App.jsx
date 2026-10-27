import { Suspense, lazy } from 'react'
import { Route, Routes } from 'react-router'

import BrandLoader from './components/BrandLoader.jsx'
import Layout from './components/Layout.jsx'
import AnalysisResult from './pages/AnalysisResult.jsx'
import Analyze from './pages/Analyze.jsx'
import Community from './pages/Community.jsx'
import History from './pages/History.jsx'
import Home from './pages/Home.jsx'
import { Disclaimer, Privacy, Terms } from './pages/Legal.jsx'
import Login from './pages/Login.jsx'
import LoginCallback from './pages/LoginCallback.jsx'
import NotFound from './pages/NotFound.jsx'
import Profile from './pages/Profile.jsx'
import Queue from './pages/Queue.jsx'
import Status from './pages/Status.jsx'

// The credits carry the whole dependency list (src/data/credits.json): loaded
// when someone opens them, not with every page.
const Credits = lazy(() => import('./pages/Credits.jsx'))
import Recent from './pages/Recent.jsx'
import TimingPage from './pages/TimingPage.jsx'

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
        {/* A published timing's own page (W3.27); deploy/web/serve.mjs writes its link preview. */}
        <Route path="t/:id" element={<TimingPage />} />
        <Route path="login" element={<Login />} />
        {/* The SSO's redirect_uri: SITE_URL + /login/callback, registered with Mides. */}
        <Route path="login/callback" element={<LoginCallback />} />
        <Route path="profile" element={<Profile />} />
        <Route path="status" element={<Status />} />
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
