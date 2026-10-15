import { describe, it, expect } from 'vitest';
import { safeReturnTo, accessDestination } from './authReturnTo';
describe('auth destinations', () => {
  it('strips legacy token/bootstrap injection parameters', () =>
    expect(
      safeReturnTo(
        '/board?access_token=untrusted&clear_access_token=true&week=2026-10-12',
      ),
    ).toBe('/board?week=2026-10-12'));
  it.each([
    'https://evil.test',
    '//evil.test',
    '/%2Fevil.test',
    '/\\evil.test',
    '/login',
    '/subscribe',
    '/unknown',
    '/%00',
    '/board%5cother',
  ])('rejects unsafe destination %s', (value) =>
    expect(safeReturnTo(value)).toBe('/'),
  );
  it('retains known local routes and filters', () =>
    expect(safeReturnTo('/board?week=2026-10-12')).toBe(
      '/board?week=2026-10-12',
    ));
  it('does not restore a management page for member', () =>
    expect(
      accessDestination(
        { state: 'READY', membership: { role: 'MEMBER' } },
        '/settings',
      ),
    ).toBe('/?accessMessage=member'));
  it.each([
    ['NO_ACCESS', '/no-access'],
    ['REVOKED', '/access-revoked'],
    ['PAYMENT_REQUIRED', '/subscribe'],
  ])('routes %s without guessing a family', (state, path) =>
    expect(accessDestination({ state })).toBe(path),
  );
  it('sends incomplete owner to onboarding', () =>
    expect(
      accessDestination({
        state: 'ONBOARDING_REQUIRED',
        membership: { role: 'OWNER' },
      }),
    ).toBe('/onboarding'));
});
