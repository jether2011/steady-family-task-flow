import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider } from '@/lib/AuthContext';
import ProtectedRoute from '@/components/ProtectedRoute';
import ScrollToTop from './components/ScrollToTop';
// Add page imports here
import Layout from '@/components/Layout';
import Login from '@/pages/Login';
import Home from '@/pages/Home';
import Board from '@/pages/Board';
import Members from '@/pages/Members';
import Leaderboard from '@/pages/Leaderboard';
import Wall from '@/pages/Wall';
import Settings from '@/pages/Settings';
import Onboarding from '@/pages/Onboarding';
import TaskTemplates from '@/pages/TaskTemplates';
import MemberProfile from '@/pages/MemberProfile';
import PointsHistory from '@/pages/PointsHistory';
import FamilyAwards from '@/pages/FamilyAwards';

// Google OAuth is the only authentication method (R1.8 / DP-3). Every route is
// gated by ProtectedRoute: while the Supabase session is resolving it shows a
// loading fallback, and when there is no session it renders the single
// "Continue with Google" login screen. Wall Mode and all other routes require
// auth as well.
const AuthenticatedApp = () => {
  return (
    <Routes>
      <Route element={<ProtectedRoute unauthenticatedElement={<Login />} />}>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/board" element={<Board />} />
          <Route path="/members" element={<Members />} />
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/wall" element={<Wall />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/task-templates" element={<TaskTemplates />} />
          <Route path="/member-profile" element={<MemberProfile />} />
          <Route path="/points-history" element={<PointsHistory />} />
          <Route path="/family-awards" element={<FamilyAwards />} />
        </Route>
        <Route path="*" element={<PageNotFound />} />
      </Route>
    </Routes>
  );
};


function App() {

  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <ScrollToTop />
          <AuthenticatedApp />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  )
}

export default App
