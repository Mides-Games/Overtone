import { Route, Routes } from 'react-router'

import Layout from './components/Layout.jsx'
import AnalysisResult from './pages/AnalysisResult.jsx'
import Analyze from './pages/Analyze.jsx'
import Home from './pages/Home.jsx'
import Login from './pages/Login.jsx'
import LoginCallback from './pages/LoginCallback.jsx'
import NotFound from './pages/NotFound.jsx'
import Profile from './pages/Profile.jsx'
import Queue from './pages/Queue.jsx'
import Status from './pages/Status.jsx'

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="analyze" element={<Analyze />} />
        <Route path="analyze/:id" element={<AnalysisResult />} />
        <Route path="queue" element={<Queue />} />
        <Route path="login" element={<Login />} />
        {/* The SSO's redirect_uri: SITE_URL + /login/callback, registered with Mides. */}
        <Route path="login/callback" element={<LoginCallback />} />
        <Route path="profile" element={<Profile />} />
        <Route path="status" element={<Status />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  )
}
