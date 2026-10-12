import React, { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LogIn, Loader2 } from 'lucide-react';
import AuthLayout from '@/components/AuthLayout';
import GoogleIcon from '@/components/GoogleIcon';
import AuthCaptcha from '@/components/AuthCaptcha';
import AccessStatus from '@/pages/AccessStatus';
import { useAuth } from '@/lib/AuthContext';
import { accessDestination, safeReturnTo } from '@/lib/authReturnTo';
import {
  captchaSiteKey,
  normalizeLoginEmail,
  validLoginEmail,
} from '@/lib/authProvider';
export default function Login() {
  const auth = useAuth(),
    location = useLocation();
  const returnTo = safeReturnTo(
    new URLSearchParams(location.search).get('returnTo'),
  );
  const [phase, setPhase] = useState('EMAIL_ENTRY'),
    [email, setEmail] = useState(''),
    [pendingEmail, setPendingEmail] = useState(''),
    [code, setCode] = useState(''),
    [message, setMessage] = useState(''),
    [error, setError] = useState(''),
    [deadline, setDeadline] = useState(0),
    [seconds, setSeconds] = useState(0),
    [captchaToken, setCaptchaToken] = useState(''),
    [captchaReset, setCaptchaReset] = useState(0);
  const operation = useRef(0),
    busy = useRef(false);
  useEffect(
    () => () => {
      operation.current++;
      auth.cancelEmailSignIn?.();
    },
    [auth.cancelEmailSignIn],
  );
  useEffect(() => {
    const tick = () =>
      setSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    if (!deadline) return;
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [deadline]);
  const request = async (event, resend = false) => {
    event?.preventDefault();
    if (busy.current || (resend && seconds > 0)) return;
    const address = normalizeLoginEmail(resend ? pendingEmail : email);
    if (!validLoginEmail(address)) {
      setError('Enter a valid email address.');
      return;
    }
    const turn = ++operation.current;
    busy.current = true;
    setPhase('SENDING');
    setError('');
    setMessage('');
    try {
      const result = await auth.requestEmailCode(address, captchaToken);
      if (turn !== operation.current) return;
      setPendingEmail(result.email);
      setCode('');
      setDeadline(Date.now() + Math.max(60, result.retryAfter) * 1000);
      setMessage('If the request can be processed, a code will be sent.');
      setPhase('CODE_ENTRY');
    } catch (err) {
      if (turn === operation.current) {
        setError(err.message);
        setDeadline(Date.now() + Math.max(60, err.retryAfter ?? 60) * 1000);
        setPhase(resend ? 'CODE_ENTRY' : 'EMAIL_ENTRY');
      }
    } finally {
      if (turn === operation.current) {
        busy.current = false;
        setCaptchaToken('');
        setCaptchaReset((n) => n + 1);
      }
    }
  };
  const verify = async (event) => {
    event.preventDefault();
    if (busy.current) return;
    if (!/^\d{6}$/.test(code)) {
      setError('Enter the six-digit code from your email.');
      return;
    }
    const turn = ++operation.current;
    busy.current = true;
    setPhase('VERIFYING');
    setError('');
    try {
      await auth.verifyEmailCode(pendingEmail, code);
      if (turn === operation.current) setPhase('RESOLVING_ACCESS');
    } catch (err) {
      if (turn === operation.current) {
        setError(err.message);
        setPhase('CODE_ENTRY');
      }
    } finally {
      if (turn === operation.current) busy.current = false;
    }
  };
  const changeEmail = () => {
    operation.current++;
    auth.cancelEmailSignIn();
    busy.current = false;
    setPhase('EMAIL_ENTRY');
    setPendingEmail('');
    setCode('');
    setMessage('');
    setError('');
    setDeadline(0);
    setCaptchaToken('');
    setCaptchaReset((n) => n + 1);
  };
  const google = async () => {
    if (busy.current) return;
    operation.current++;
    auth.cancelEmailSignIn?.();
    busy.current = true;
    setPhase('GOOGLE');
    setError('');
    try {
      await (auth.loginWithGoogle ?? auth.login)(returnTo);
    } catch {
      setError('Could not start Google sign-in. Please try again.');
      setPhase('EMAIL_ENTRY');
      busy.current = false;
    }
  };
  if (auth.isAuthenticated) {
    if (auth.authError) return <AccessStatus />;
    if (auth.access && !auth.isLoadingAuth)
      return <Navigate replace to={accessDestination(auth.access, returnTo)} />;
    return (
      <div role="status" className="p-8">
        Resolving family access…
      </div>
    );
  }
  const waiting = [
    'SENDING',
    'VERIFYING',
    'RESOLVING_ACCESS',
    'GOOGLE',
  ].includes(phase);
  return (
    <AuthLayout icon={LogIn} title="Welcome" subtitle="Sign in to your family">
      {(error || auth.authError?.message) && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error || auth.authError.message}
        </p>
      )}
      {message && (
        <p role="status" className="mb-4 text-sm">
          {message}
        </p>
      )}
      {auth.emailOtpEnabled && (
        <div className="space-y-4 mb-6">
          {pendingEmail &&
          ['CODE_ENTRY', 'VERIFYING', 'RESOLVING_ACCESS', 'SENDING'].includes(
            phase,
          ) ? (
            <>
              <p className="text-sm">
                Enter the code for <strong>{pendingEmail}</strong>.
              </p>
              <form onSubmit={verify} className="space-y-3">
                <Label htmlFor="login-code">Six-digit email code</Label>
                <Input
                  id="login-code"
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  disabled={waiting}
                  autoFocus
                />
                <Button
                  type="submit"
                  className="w-full"
                  disabled={waiting || code.length !== 6}
                >
                  {phase === 'VERIFYING' ? 'Verifying…' : 'Verify code'}
                </Button>
              </form>
              <AuthCaptcha onToken={setCaptchaToken} resetKey={captchaReset} />
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={
                  waiting || seconds > 0 || (!!captchaSiteKey && !captchaToken)
                }
                onClick={(e) => request(e, true)}
              >
                {seconds > 0 ? `Resend in ${seconds}s` : 'Resend code'}
              </Button>
              <Button type="button" variant="ghost" onClick={changeEmail}>
                Change email
              </Button>
            </>
          ) : (
            <form onSubmit={request} className="space-y-3">
              <Label htmlFor="login-email">Email address</Label>
              <Input
                id="login-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={waiting}
                required
              />
              <AuthCaptcha onToken={setCaptchaToken} resetKey={captchaReset} />
              <Button
                type="submit"
                className="w-full"
                disabled={
                  waiting || seconds > 0 || (!!captchaSiteKey && !captchaToken)
                }
              >
                {phase === 'SENDING'
                  ? 'Sending…'
                  : seconds > 0
                    ? `Try again in ${seconds}s`
                    : 'Continue with email'}
              </Button>
            </form>
          )}
          {phase === 'SENDING' && !pendingEmail && (
            <Button type="button" variant="ghost" onClick={changeEmail}>
              Change email
            </Button>
          )}
        </div>
      )}
      {waiting && (
        <p role="status" className="mb-3 text-sm">
          {phase === 'GOOGLE'
            ? 'Redirecting to Google…'
            : phase === 'SENDING'
              ? 'Requesting email code…'
              : phase === 'VERIFYING'
                ? 'Verifying code…'
                : 'Resolving family access…'}
        </p>
      )}
      <Button
        className="w-full h-12 text-sm font-medium"
        variant={auth.emailOtpEnabled ? 'outline' : 'default'}
        onClick={google}
        disabled={waiting}
      >
        {phase === 'GOOGLE' ? (
          <Loader2 className="w-4 h-4 mr-2 animate-spin" aria-hidden="true" />
        ) : (
          <GoogleIcon className="w-5 h-5 mr-2" />
        )}
        Continue with Google
      </Button>
    </AuthLayout>
  );
}
