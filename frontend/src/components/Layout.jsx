import React from 'react';
import { NavLink, Outlet, Navigate } from 'react-router-dom';
import { useFamily } from '@/hooks/useFamily';
import { useAuth } from '@/lib/AuthContext';
import {
  LayoutDashboard,
  LayoutGrid,
  Users,
  Trophy,
  Settings,
  Monitor,
  Loader2,
  LogOut,
  Gift,
  Repeat,
  ScrollText
} from 'lucide-react';
import { cn } from '@/lib/utils';

const navItems = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/board', label: 'Board', icon: LayoutGrid },
  { to: '/members', label: 'Members', icon: Users },
  { to: '/leaderboard', label: 'Leaderboard', icon: Trophy },
  { to: '/family-awards', label: 'Awards', icon: Gift },
  { to: '/task-templates', label: 'Templates', icon: Repeat },
  { to: '/points-history', label: 'History', icon: ScrollText },
  { to: '/settings', label: 'Settings', icon: Settings }
];

function NavItem({ to, label, icon: Icon, end }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors',
          isActive
            ? 'bg-primary text-primary-foreground shadow-sm'
            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
        )
      }
    >
      <Icon className="w-[18px] h-[18px]" />
      {label}
    </NavLink>
  );
}

function MobileNavItem({ to, label, icon: Icon, end }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'flex-shrink-0 w-16 flex flex-col items-center gap-1 py-2.5 text-[10px] font-medium transition-colors',
          isActive ? 'text-primary' : 'text-muted-foreground'
        )
      }
    >
      <Icon className="w-5 h-5" />
      {label}
    </NavLink>
  );
}

export default function Layout() {
  const { data: family, isLoading } = useFamily();
  const { logout } = useAuth();

  if (isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!family) {
    return <Navigate to="/onboarding" replace />;
  }

  return (
    <div className="min-h-screen flex bg-background">
      <aside className="hidden lg:flex w-64 flex-col border-r border-border bg-card/60 backdrop-blur-sm sticky top-0 h-screen">
        <div className="p-6">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center shadow-sm">
              <span className="text-primary-foreground font-bold text-lg">F</span>
            </div>
            <div className="min-w-0">
              <h1 className="font-heading font-bold text-lg leading-none">FamTask</h1>
              <p className="text-xs text-muted-foreground mt-1 truncate max-w-[150px]">{family.name}</p>
            </div>
          </div>
        </div>
        <nav className="flex-1 px-3 space-y-1">
          {navItems.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
        </nav>
        <div className="p-3 space-y-1 border-t border-border">
          <NavLink
            to="/wall"
            className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <Monitor className="w-[18px] h-[18px]" />
            Wall Mode
          </NavLink>
          <button
            onClick={() => logout()}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <LogOut className="w-[18px] h-[18px]" />
            Log out
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="lg:hidden sticky top-0 z-30 flex items-center justify-between px-4 h-14 border-b border-border bg-card/80 backdrop-blur">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
              <span className="text-primary-foreground font-bold text-sm">F</span>
            </div>
            <span className="font-heading font-bold">FamTask</span>
          </div>
          <NavLink
            to="/wall"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <Monitor className="w-4 h-4" />
            Wall
          </NavLink>
        </header>

        <main className="flex-1 overflow-y-auto scrollbar-thin pb-20 lg:pb-0">
          <Outlet />
        </main>

        <nav className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-card/95 backdrop-blur border-t border-border">
          <div className="flex overflow-x-auto no-scrollbar">
            {navItems.map((item) => (
              <MobileNavItem key={item.to} {...item} />
            ))}
          </div>
        </nav>
      </div>
    </div>
  );
}