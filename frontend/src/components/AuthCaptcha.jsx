import { useEffect, useRef, useState } from 'react';
import { captchaSiteKey } from '@/lib/authProvider';
let loader;
function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loader)
    loader = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src =
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = () => resolve(window.turnstile);
      script.onerror = () => {
        script.remove();
        loader = null;
        reject(new Error('unavailable'));
      };
      document.head.appendChild(script);
    });
  return loader;
}
export default function AuthCaptcha({ onToken, resetKey }) {
  const host = useRef(null);
  const [failed, setFailed] = useState(false),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!captchaSiteKey) return;
    let active = true,
      widget,
      api;
    onToken('');
    setFailed(false);
    loadTurnstile()
      .then((loaded) => {
        if (!active) return;
        api = loaded;
        widget = api.render(host.current, {
          sitekey: captchaSiteKey,
          callback: (token) => {
            if (active) {
              setFailed(false);
              onToken(token);
            }
          },
          'expired-callback': () => {
            if (active) onToken('');
          },
          'error-callback': () => {
            if (active) {
              onToken('');
              setFailed(true);
            }
          },
        });
      })
      .catch(() => {
        if (active) {
          onToken('');
          setFailed(true);
        }
      });
    return () => {
      active = false;
      if (widget !== undefined) api?.remove(widget);
    };
  }, [onToken, resetKey, attempt]);
  return captchaSiteKey ? (
    <div>
      <div ref={host} />
      {failed && (
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          Retry security check
        </button>
      )}
      <p className="text-xs text-muted-foreground">
        Complete the security check before requesting a code. If it does not
        load, retry or use Google.
      </p>
    </div>
  ) : null;
}
