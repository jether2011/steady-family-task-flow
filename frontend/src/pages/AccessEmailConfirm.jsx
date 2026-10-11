import { useState } from 'react';
import { useAuth } from '@/lib/AuthContext';
import { supabase } from '@/lib/supabaseClient';
import { post } from '@/api/client';
export default function AccessEmailConfirm() {
  const { user, login, retryAccessResolution } = useAuth();
  const [token] = useState(
    () => new URLSearchParams(window.location.search).get('token') ?? '',
  );
  const [email, setEmail] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const update = async () => {
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ email });
      if (error) throw error;
      setMessage(
        'Complete the email verification instructions sent by the sign-in provider, then return here to confirm.',
      );
    } catch {
      setMessage(
        'Could not start email verification. Check the address and retry.',
      );
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    setBusy(true);
    try {
      await post('/me/email-change/confirm', { token });
      window.history.replaceState({}, '', window.location.pathname);
      await retryAccessResolution();
      setMessage(
        'Login email confirmed. You can return to the family dashboard.',
      );
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="max-w-lg mx-auto p-8 space-y-4">
      <h1 className="text-xl font-bold">Confirm your login email</h1>
      <p>
        Keep the same sign-in account. Verify its new mailbox before confirming
        family access.
      </p>
      {!user ? (
        <button onClick={login}>Sign in to your existing account</button>
      ) : (
        <>
          <label htmlFor="new-email">New email</label>
          <input
            id="new-email"
            type="email"
            className="border p-2 w-full"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button disabled={busy || !email} onClick={update}>
            Verify new mailbox
          </button>
          <button disabled={busy || !token} onClick={confirm}>
            Confirm family access
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
      <a href="/">Return home</a>
    </main>
  );
}
