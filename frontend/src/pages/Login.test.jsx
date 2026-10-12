import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
const state = vi.hoisted(() => ({ auth: {} }));
vi.mock('@/lib/AuthContext', () => ({ useAuth: () => state.auth }));
vi.mock('@/components/AuthCaptcha', () => ({ default: () => null }));
import Login from './Login';
beforeEach(() => {
  state.auth = {
    emailOtpEnabled: true,
    isAuthenticated: false,
    requestEmailCode: vi.fn(async (email) => ({ email, retryAfter: 60 })),
    verifyEmailCode: vi.fn(async () => {}),
    loginWithGoogle: vi.fn(async () => {}),
    cancelEmailSignIn: vi.fn(),
  };
});
afterEach(() => vi.useRealTimers());
function view() {
  return render(
    <MemoryRouter initialEntries={['/login?returnTo=%2Fboard']}>
      <Login />
    </MemoryRouter>,
  );
}
async function send() {
  fireEvent.change(screen.getByLabelText('Email address'), {
    target: { value: ' Person@Example.test ' },
  });
  fireEvent.submit(screen.getByLabelText('Email address').closest('form'));
  await screen.findByLabelText('Six-digit email code');
}
describe('email and Google login choices', () => {
  it('normalizes requests, supports paste and verifies only once', async () => {
    view();
    await send();
    expect(state.auth.requestEmailCode).toHaveBeenCalledWith(
      'person@example.test',
      '',
    );
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Six-digit email code'));
    await user.paste('012345');
    expect(screen.getByLabelText('Six-digit email code')).toHaveValue('012345');
    fireEvent.submit(
      screen.getByLabelText('Six-digit email code').closest('form'),
    );
    fireEvent.submit(
      screen.getByLabelText('Six-digit email code').closest('form'),
    );
    expect(state.auth.verifyEmailCode).toHaveBeenCalledTimes(1);
    expect(state.auth.verifyEmailCode).toHaveBeenCalledWith(
      'person@example.test',
      '012345',
    );
  });
  it('respects resend cooldown and keeps the pending address fixed', async () => {
    vi.useFakeTimers();
    view();
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'person@example.test' },
    });
    await act(async () => {
      fireEvent.submit(screen.getByLabelText('Email address').closest('form'));
    });
    expect(
      screen.getByRole('button', { name: 'Resend in 60s' }),
    ).toBeDisabled();
    await act(async () => {
      vi.advanceTimersByTime(60000);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Resend code' }));
    await act(async () => {});
    expect(state.auth.requestEmailCode).toHaveBeenCalledTimes(2);
    expect(state.auth.requestEmailCode).toHaveBeenLastCalledWith(
      'person@example.test',
      '',
    );
  });
  it('honors a longer provider cooldown', async () => {
    state.auth.requestEmailCode.mockResolvedValue({
      email: 'person@example.test',
      retryAfter: 120,
    });
    view();
    await send();
    expect(
      screen.getByRole('button', { name: 'Resend in 120s' }),
    ).toBeDisabled();
  });
  it('change email clears code and ignores delayed request results', async () => {
    view();
    await send();
    fireEvent.change(screen.getByLabelText('Six-digit email code'), {
      target: { value: '123456' },
    });
    let complete;
    state.auth.verifyEmailCode.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    fireEvent.submit(
      screen.getByLabelText('Six-digit email code').closest('form'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Change email' }));
    await act(async () => {
      complete();
    });
    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
    expect(
      screen.queryByLabelText('Six-digit email code'),
    ).not.toBeInTheDocument();
    expect(state.auth.cancelEmailSignIn).toHaveBeenCalled();
  });
  it('shows generic verification error and allows retry', async () => {
    state.auth.verifyEmailCode.mockRejectedValue(
      new Error('This code is invalid or expired. Request a new code.'),
    );
    view();
    await send();
    fireEvent.change(screen.getByLabelText('Six-digit email code'), {
      target: { value: '123456' },
    });
    fireEvent.submit(
      screen.getByLabelText('Six-digit email code').closest('form'),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'invalid or expired',
    );
    expect(screen.getByRole('button', { name: 'Verify code' })).toBeEnabled();
  });
  it('retains Google with a safe destination and permits retry on failure', async () => {
    state.auth.loginWithGoogle.mockRejectedValue(
      new Error('provider secret details'),
    );
    view();
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with Google' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not start Google',
    );
    expect(
      screen.getByRole('button', { name: 'Continue with Google' }),
    ).toBeEnabled();
    expect(state.auth.loginWithGoogle).toHaveBeenCalledWith('/board');
  });
  it('can change email while sending and ignores a late delivery result', async () => {
    let complete;
    state.auth.requestEmailCode.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    view();
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'first@example.test' },
    });
    fireEvent.submit(screen.getByLabelText('Email address').closest('form'));
    fireEvent.click(screen.getByRole('button', { name: 'Change email' }));
    await act(async () => {
      complete({ email: 'first@example.test', retryAfter: 60 });
    });
    expect(screen.getByLabelText('Email address')).toBeEnabled();
    expect(
      screen.queryByLabelText('Six-digit email code'),
    ).not.toBeInTheDocument();
  });
  it('hides email requests when disabled', () => {
    state.auth.emailOtpEnabled = false;
    view();
    expect(screen.queryByLabelText('Email address')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Continue with Google' }),
    ).toBeInTheDocument();
  });
});
