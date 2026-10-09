import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { LogIn, Loader2 } from "lucide-react";
import AuthLayout from "@/components/AuthLayout";
import GoogleIcon from "@/components/GoogleIcon";
import { useAuth } from "@/lib/AuthContext";

// Single "Continue with Google" screen (R1.8 / DP-3). Google OAuth is the only
// supported authentication method; the email/password UI and routes have been
// removed. Signing in starts the Supabase OAuth flow via AuthContext's
// login(); Supabase handles the redirect back and the AuthProvider restores
// the session, after which ProtectedRoute renders the app.
export default function Login() {
  const { login } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleGoogle = async () => {
    setError("");
    setLoading(true);
    try {
      await login();
    } catch (err) {
      setError(err?.message || "Could not start Google sign-in. Please try again.");
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      icon={LogIn}
      title="Welcome"
      subtitle="Sign in to manage your family's tasks"
    >
      {error && (
        <div className="mb-4 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
          {error}
        </div>
      )}

      <Button
        className="w-full h-12 text-sm font-medium"
        onClick={handleGoogle}
        disabled={loading}
      >
        {loading ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
            Redirecting to Google...
          </>
        ) : (
          <>
            <GoogleIcon className="w-5 h-5 mr-2" />
            Continue with Google
          </>
        )}
      </Button>
    </AuthLayout>
  );
}
