import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '@open-design/components';
import type { CompanySessionResponse } from '@open-design/contracts';
import { useT } from '../i18n';
import { MatrixLoader } from '../components/MatrixLoader';
import { Icon } from '../components/Icon';
import { LanguageMenu } from '../components/LanguageMenu';
import styles from './company.module.css';

const localSession: CompanySessionResponse = {
  enabled: false,
  user: null,
  presentation: { showAgentIdentity: false, hiddenSettingsSections: ['labs', 'integrations'] },
};
export const COMPANY_SESSION_CHANGED_EVENT = 'open-design:company-session-changed';
const CompanyContext = createContext({
  ...localSession,
  isMember: false,
  logout: async () => {},
});
export const useCompany = () => useContext(CompanyContext);

export class CompanyRequestError extends Error {
  constructor(message: string, public readonly code?: string, public readonly status?: number) {
    super(message);
    this.name = 'CompanyRequestError';
  }
}

function readCompanySession(value: CompanySessionResponse): CompanySessionResponse {
  if (!value || typeof value.enabled !== 'boolean' || !value.presentation
    || typeof value.presentation.showAgentIdentity !== 'boolean' || !Array.isArray(value.presentation.hiddenSettingsSections)
    || (value.user !== null && (!value.user || typeof value.user.id !== 'string'
      || typeof value.user.username !== 'string' || !['admin', 'member'].includes(value.user.role)
      || typeof value.user.mustChangePassword !== 'boolean'))
    || (value.enabled && value.user && !value.csrfToken)) throw new Error('Invalid company session');
  return value;
}

export async function companyRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json();
  if (!response.ok) throw new CompanyRequestError(typeof body.error === 'string' ? body.error : 'Request failed', typeof body.code === 'string' ? body.code : undefined, response.status);
  return body as T;
}

export function CompanyProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [session, setSession] = useState<CompanySessionResponse | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const originalFetch = useRef(globalThis.fetch);
  const [transportReady, setTransportReady] = useState(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    let active = true;
    setError(false);
    void originalFetch.current.call(globalThis, '/api/company/session', { credentials: 'same-origin', cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('Session unavailable');
        const value = readCompanySession(await response.json());
        if (active) setSession(value);
      }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);

  // Existing transports use fetch directly. Scope the bridge to authenticated
  // same-origin daemon APIs; external providers never receive a session token.
  useLayoutEffect(() => {
    if (!session?.enabled || !session.user) { setTransportReady(true); return; }
    const previous = globalThis.fetch;
    const wrapped: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input), window.location.href);
      if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/')) return previous(input, init);
      const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
      const headers = new Headers(request?.headers);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && session.csrfToken) headers.set('x-csrf-token', session.csrfToken);
      const response = await previous(input, { ...init, headers, credentials: 'same-origin' });
      if (response.status === 401 && sessionRef.current?.csrfToken === session.csrfToken) {
        setSession(value => value ? { ...value, user: null, csrfToken: undefined } : value);
        window.dispatchEvent(new Event(COMPANY_SESSION_CHANGED_EVENT));
      }
      return response;
    };
    globalThis.fetch = wrapped;
    setTransportReady(true);
    return () => { if (globalThis.fetch === wrapped) globalThis.fetch = previous; };
  }, [session?.enabled, session?.user?.id, session?.csrfToken]);

  const logout = useCallback(async () => {
    await companyRequest('/api/company/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    setSession(value => value ? { ...value, user: null, csrfToken: undefined } : value);
    window.dispatchEvent(new Event(COMPANY_SESSION_CHANGED_EVENT));
  }, []);

  if (error) return <main className={styles.gate}><div className={styles.panel}><p role="alert">{t('company.sessionError')}</p><Button onClick={() => setAttempt(value => value + 1)}>{t('company.retry')}</Button></div></main>;
  if (!session || !transportReady) return <main className={styles.gate} role="status" aria-label="Loading NexusDesign"><MatrixLoader /></main>;
  if (session.enabled && (!session.user || session.user.mustChangePassword)) {
    return <CompanyLogin passwordChange={Boolean(session.user?.mustChangePassword)} onSession={value => { setSession(value); window.dispatchEvent(new Event(COMPANY_SESSION_CHANGED_EVENT)); }} />;
  }
  return <CompanyContext.Provider value={{ ...session, isMember: session.enabled && session.user?.role === 'member', logout }}>{children}</CompanyContext.Provider>;
}

function CompanyLogin({ passwordChange, onSession }: { passwordChange: boolean; onSession: (session: CompanySessionResponse) => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError(false);
    try {
      const body = passwordChange
        ? { currentPassword: data.get('password'), newPassword: data.get('newPassword') }
        : { username: data.get('username'), password: data.get('password') };
      onSession(readCompanySession(await companyRequest<CompanySessionResponse>(`/api/company/auth/${passwordChange ? 'password' : 'login'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })));
    } catch { setError(true); }
    finally { setBusy(false); }
  }
  return <main className={`onboarding-view onboarding-view--cloud ${styles.login}`} aria-label={t('settings.welcomeTitle')}>
    <div className={`onboarding-cloud__pane ${styles.loginPane}`}>
      <div className={`onboarding-cloud__center ${styles.loginContent}`}>
        <h1 className="onboarding-cloud__title">{t(passwordChange ? 'company.changePassword' : 'settings.onboardingCloudTitle')}</h1>
        <p className="onboarding-cloud__body">{t(passwordChange ? 'company.changePasswordHint' : 'settings.onboardingCloudBody')}</p>
        <form className={styles.loginForm} aria-label={t(passwordChange ? 'company.changePassword' : 'company.signIn')} aria-busy={busy} onSubmit={event => { void submit(event); }}>
          {!passwordChange && <p className={styles.loginHint}>{t('company.signInHint')}</p>}
          {!passwordChange && <label className={styles.loginField}>{t('company.username')}<input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus disabled={busy} aria-invalid={error || undefined} aria-describedby={error ? 'company-login-error' : undefined} /></label>}
          <label className={styles.loginField}>{t(passwordChange ? 'company.currentPassword' : 'company.password')}<input name="password" type="password" autoComplete="current-password" required autoFocus={passwordChange} disabled={busy} aria-invalid={error || undefined} aria-describedby={error ? 'company-login-error' : undefined} /></label>
          {passwordChange && <label className={styles.loginField}>{t('company.newPassword')}<input name="newPassword" type="password" autoComplete="new-password" minLength={12} required disabled={busy} /></label>}
          {error && <p id="company-login-error" className={styles.loginError} role="alert">{t(passwordChange ? 'company.passwordError' : 'company.loginError')}</p>}
          <button type="submit" className={`onboarding-cloud__primary ${styles.loginSubmit}`} disabled={busy} aria-busy={busy}>
            {busy ? <MatrixLoader size={17} /> : <Icon name="log-in" size={17} />}
            <span>{t(passwordChange ? 'company.changePassword' : 'company.signIn')}</span>
          </button>
        </form>
      </div>
      <footer className={`onboarding-cloud__footer ${styles.loginFooter}`}>
        <LanguageMenu placement="up" align="start" />
        <span>© {new Date().getFullYear()} NexusDesign · {t('settings.onboardingCloudRights')}</span>
      </footer>
    </div>
    <div className="onboarding-cloud__art" aria-hidden="true"><img src="/onboarding/registration-invite-art.webp" alt="" /></div>
  </main>;
}
