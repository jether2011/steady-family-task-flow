import { useEffect, useState } from 'react';
import { members } from '@/api/members.api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
export default function MemberAccess({ memberId }) {
  const [access, setAccess] = useState(null),
    [email, setEmail] = useState(''),
    [role, setRole] = useState('MEMBER');
  const [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const load = async () => {
    const a = await members.getAccess(memberId);
    setAccess(a);
    setEmail(a?.email ?? '');
    setRole(a?.role ?? 'MEMBER');
    setLoaded(true);
  };
  useEffect(() => {
    let active = true;
    members
      .getAccess(memberId)
      .then((a) => {
        if (active) {
          setAccess(a);
          setEmail(a?.email ?? '');
          setRole(a?.role ?? 'MEMBER');
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (active) setMessage(e.message);
      });
    return () => {
      active = false;
    };
  }, [memberId]);
  const save = async (enabled) => {
    setBusy(true);
    setMessage('');
    try {
      if (
        enabled &&
        access &&
        access.email?.toLowerCase() !== email.trim().toLowerCase() &&
        access.status !== 'PROVISIONED'
      ) {
        const result = await members.changeEmail(
          memberId,
          email,
          access.accessVersion,
        );
        setMessage(
          `Access revoked while the new email is verified. Instructions sent; valid until ${new Date(result.expiresAt).toLocaleString()}.`,
        );
      } else {
        await members.setAccess(memberId, {
          enabled,
          ...(enabled ? { email, role } : {}),
          expectedVersion: access?.accessVersion ?? 0,
        });
        setMessage(
          enabled
            ? 'Access saved. Re-enabling cancels any pending email change.'
            : 'Login access revoked.',
        );
      }
      await load();
    } catch (e) {
      setMessage(e.message);
      try {
        await load();
      } catch {
        /* Retain the error for retry. */
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="border-t pt-4 space-y-2">
      <h3 className="font-semibold">Login access</h3>
      <p className="text-xs">
        {loaded ? (access?.status ?? 'No login enabled') : 'Loading access…'}.
        Member type does not determine permissions.
      </p>
      <Label htmlFor="access-email">Login email</Label>
      <Input
        id="access-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        disabled={!loaded || busy}
      />
      <Label htmlFor="access-role">Access role</Label>
      <select
        id="access-role"
        className="w-full border rounded p-2"
        value={role}
        onChange={(e) => setRole(e.target.value)}
        disabled={!loaded || busy}
      >
        <option value="MEMBER">Member — view only</option>
        <option value="MANAGER">Manager — manage household</option>
      </select>
      <div className="flex gap-2">
        <Button
          type="button"
          disabled={!loaded || busy || !email.trim()}
          onClick={() => save(true)}
        >
          Save login access
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!loaded || busy || !access}
          onClick={() => save(false)}
        >
          Revoke login
        </Button>
      </div>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
