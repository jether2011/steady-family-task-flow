import { Toaster } from '@/components/ui/toaster';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClientInstance } from '@/lib/query-client';
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider } from '@/lib/AuthContext';
import ProtectedRoute from '@/components/ProtectedRoute';
import ScrollToTop from './components/ScrollToTop';
// Add page imports here
import Layout from '@/components/Layout';
import AccessEmailConfirm from '@/pages/AccessEmailConfirm';
import AccessStatus from '@/pages/AccessStatus';
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

// Public login and access notices resolve identity before protected family pages.
const AuthenticatedApp = () => {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/create-family" element={<Onboarding creating />} />
      {['/no-access', '/access-revoked', '/access-error', '/subscribe'].map(
        (path) => (
          <Route key={path} path={path} element={<AccessStatus />} />
        ),
      )}
      <Route path="/access-email-confirm" element={<AccessEmailConfirm />} />
      <Route element={<ProtectedRoute />}>
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
  );
}

export default App;
