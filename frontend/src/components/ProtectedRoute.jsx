import { Outlet } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';

const DefaultFallback = () => (
  <div className="fixed inset-0 flex items-center justify-center">
    <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
  </div>
);

// Gates routes behind a valid Supabase session. The AuthProvider restores the
// session on mount (getSession) and keeps it reactive (onAuthStateChange), so
// here we only need to read the resulting state: show the fallback while the
// session is still being resolved, render the unauthenticated element (the
// Google OAuth login screen) when there is no session, and otherwise render the
// protected children.
export default function ProtectedRoute({ fallback = <DefaultFallback />, unauthenticatedElement }) {
  const { isAuthenticated, isLoadingAuth, authChecked } = useAuth();

  if (isLoadingAuth || !authChecked) {
    return fallback;
  }

  if (!isAuthenticated) {
    return unauthenticatedElement;
  }

  return <Outlet />;
}
