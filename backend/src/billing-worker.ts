/** Separate supervised process. Leases/inbox/schedule survive crashes and replicas. */
import {
  projectEntitlements,
  publishEntitlementPolicy,
} from './modules/entitlements/entitlements.worker.js';
import { accessRpc } from './modules/access/access.repository.js';
import { env } from './config/env.js';
import { runAccount, runInbox } from './modules/billing/billing.worker.js';
import { getServiceRoleClient } from './config/supabase.js';
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    stopping = true;
  });
if (!env.STRIPE_ACCOUNT_ID || !env.STRIPE_SECRET_KEY)
  throw new Error(
    'Billing worker requires STRIPE_ACCOUNT_ID and STRIPE_SECRET_KEY',
  );
const cohort = process.argv.indexOf('--entitlement-cohort');
const exception = process.argv.indexOf('--entitlement-exception');
const release = process.argv.indexOf('--release-account');
const replay = process.argv.indexOf('--replay');
if (cohort !== -1 || exception !== -1) {
  const index = cohort !== -1 ? cohort : exception;
  const id = process.argv[index + 1];
  const reason = process.argv[index + 3];
  const until = exception !== -1 ? process.argv[index + 2] : null;
  if (
    !id ||
    !/^[a-f0-9-]{36}$/i.test(id) ||
    !reason ||
    (cohort !== -1 && process.argv[index + 2] !== 'enforce') ||
    (until && !Number.isFinite(Date.parse(until)))
  )
    throw new Error(
      'Family UUID, enforce or explicit exception expiry, and reviewed incident reference are required',
    );
  await publishEntitlementPolicy();
  await accessRpc('entitlement_rollout', {
    p_family: id,
    p_enforced: true,
    p_reason: reason,
    p_exception_until: until,
  });
  console.info('Audited entitlement rollout operation applied');
} else if (release !== -1) {
  const id = process.argv[release + 1],
    review = process.argv[release + 2];
  if (!id || !review || !/^[a-f0-9-]{36}$/i.test(id))
    throw new Error(
      'Account UUID and reviewed incident reference are required',
    );
  const { error } = await getServiceRoleClient().rpc(
    'billing_release_quarantine',
    { p_id: id, p_review: review },
  );
  if (error) throw new Error('Review release failed');
  console.info('Reviewed account scheduled for reconciliation');
} else if (replay !== -1) {
  const id = process.argv[replay + 1];
  if (!id || !/^[a-f0-9-]{36}$/i.test(id))
    throw new Error('A known inbox UUID is required');
  const { error } = await getServiceRoleClient().rpc('billing_replay_event', {
    p_id: id,
  });
  if (error) throw new Error('Replay failed');
  console.info('Billing event replay scheduled');
} else {
  await publishEntitlementPolicy();
  let sweep = 0;
  while (!stopping) {
    try {
      await accessRpc('entitlement_heartbeat', {
        p_name: 'billing-entitlements',
      });
      // Bounded batches avoid starvation of the reconciliation schedule.
      for (let i = 0; i < 20 && !stopping; i++) {
        const event = await runInbox();
        const account = await runAccount();
        const projection = await projectEntitlements();
        if (!event && !account && !projection) break;
      }
      if (env.BILLING_EVENT_RETENTION_DAYS && Date.now() > sweep) {
        const cutoff = new Date(
          Date.now() - env.BILLING_EVENT_RETENTION_DAYS * 86400000,
        ).toISOString();
        // Keep ID/mode/type tombstones indefinitely for dedupe; expire object references.
        const { error } = await getServiceRoleClient()
          .from('billing_events')
          .update({ object_id: null, customer_id: null })
          .in('state', ['APPLIED', 'IGNORED'])
          .lt('received_at', cutoff);
        if (error) throw new Error('retention');
        sweep = Date.now() + 3600000;
      }
    } catch {
      console.error(
        'Billing worker cycle failed; inspect durable inbox/account alerts',
      );
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
