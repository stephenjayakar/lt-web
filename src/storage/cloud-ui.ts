// Browser chrome for cloud saves: the optional sign-in gate shown before the
// game boots, and a small account/sync pill (sync status, sign in/out).

import type { CloudStatus } from './cloud-store';

export interface SignInOptions {
  error: string | null;
  fakeLogin: boolean;
  onGoogle(): Promise<void>;
  onFake(email: string, secret: string): Promise<void>;
}

const ROOT_ID = 'cloud-signin';

/** Status card shown over the page while boot finishes a cloud step. */
export function showCloudMessage(
  title: string,
  message: string,
  action?: { label: string; run(): void },
): void {
  const root = ensureRoot();
  root.innerHTML = `
    <main class="project-picker__card cloud-signin__card">
      <p class="project-picker__eyebrow">Lex Talionis · Cloud saves</p>
      <h1></h1>
      <p class="project-picker__lede cloud-signin__message"></p>
    </main>`;
  root.querySelector('h1')!.textContent = title;
  root.querySelector('.cloud-signin__message')!.textContent = message;
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cloud-signin__google';
    button.textContent = action.label;
    button.addEventListener('click', () => action.run());
    root.querySelector('main')!.appendChild(button);
  }
}

export function removeCloudScreen(): void {
  document.getElementById(ROOT_ID)?.remove();
}

function ensureRoot(): HTMLElement {
  let root = document.getElementById(ROOT_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'project-picker cloud-signin';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Sign in');
    document.body.appendChild(root);
  }
  return root;
}

/**
 * The sign-in gate. Resolves 'signed-in' after a successful (fake) sign-in
 * (Google navigates away instead), or 'local' when the player chooses to
 * play with on-device saves only.
 */
export function showSignIn(opts: SignInOptions): Promise<'signed-in' | 'local'> {
  return new Promise<'signed-in' | 'local'>((resolve) => {
    const root = ensureRoot();
    root.innerHTML = `
      <main class="project-picker__card cloud-signin__card">
        <p class="project-picker__eyebrow">Lex Talionis · Web Player</p>
        <h1>Sign in to sync saves</h1>
        <p class="project-picker__lede">Saves always stay on this device. Signing in also backs them up to the owner's Google account and syncs them between devices.</p>
        <button type="button" class="cloud-signin__google" data-google>Sign in with Google</button>
        <button type="button" class="cloud-signin__local" data-local>Play without signing in</button>
        <p class="cloud-signin__error" role="alert" hidden></p>
      </main>`;
    const card = root.querySelector('main')!;
    const errorEl = root.querySelector<HTMLElement>('.cloud-signin__error')!;
    const showError = (message: string | null) => {
      errorEl.hidden = !message;
      errorEl.textContent = message ?? '';
    };
    showError(opts.error);

    const google = root.querySelector<HTMLButtonElement>('[data-google]')!;
    google.addEventListener('click', async () => {
      google.disabled = true;
      google.textContent = 'Opening Google…';
      try {
        await opts.onGoogle();
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
        google.disabled = false;
        google.textContent = 'Sign in with Google';
      }
    });
    root.querySelector('[data-local]')!.addEventListener('click', () => resolve('local'));

    if (opts.fakeLogin) {
      const form = document.createElement('form');
      form.className = 'cloud-signin__fake';
      form.setAttribute('aria-label', 'Test sign-in');
      form.innerHTML = `
        <p class="cloud-signin__fake-title">Dev deployment test sign-in</p>
        <input name="email" type="email" autocomplete="username" placeholder="Allowed email" aria-label="Email" required />
        <input name="secret" type="password" autocomplete="current-password" placeholder="Test sign-in secret" aria-label="Test sign-in secret" required />
        <button type="submit">Test sign-in</button>`;
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        const submit = form.querySelector<HTMLButtonElement>('button')!;
        submit.disabled = true;
        try {
          await opts.onFake(String(data.get('email') ?? ''), String(data.get('secret') ?? ''));
          resolve('signed-in');
        } catch (err) {
          showError(err instanceof Error ? err.message : String(err));
        } finally {
          submit.disabled = false;
        }
      });
      card.appendChild(form);
    }
  });
}

export interface AccountPillOptions {
  email: string | null;
  signedIn: boolean;
  onSignIn(): Promise<void>;
  onSignOut(): Promise<void>;
}

export interface AccountPill {
  update(s: CloudStatus): void;
  setEmail(email: string): void;
  setSignedOut(message: string | null): void;
}

/** Account + sync pill (sync status, sign in/out). */
export function installAccountPill(opts: AccountPillOptions): AccountPill {
  document.getElementById('cloud-account')?.remove();
  const root = document.createElement('div');
  root.id = 'cloud-account';
  root.className = 'cloud-account';
  root.innerHTML = `
    <button type="button" class="cloud-account__pill" aria-expanded="false" aria-controls="cloud-account-menu">
      <span class="cloud-account__dot" aria-hidden="true"></span><span class="cloud-account__label">Cloud</span>
    </button>
    <div class="cloud-account__menu" id="cloud-account-menu" hidden>
      <p class="cloud-account__email"></p>
      <p class="cloud-account__status" aria-live="polite"></p>
      <button type="button" data-account-action></button>
    </div>`;
  const pill = root.querySelector<HTMLButtonElement>('.cloud-account__pill')!;
  const menu = root.querySelector<HTMLElement>('.cloud-account__menu')!;
  const label = root.querySelector<HTMLElement>('.cloud-account__label')!;
  const statusEl = root.querySelector<HTMLElement>('.cloud-account__status')!;
  const emailEl = root.querySelector<HTMLElement>('.cloud-account__email')!;
  const action = root.querySelector<HTMLButtonElement>('[data-account-action]')!;
  let signedIn = opts.signedIn;
  let email = opts.email;
  let signedOutMessage: string | null = null;
  let last: CloudStatus | null = null;

  const renderAccount = () => {
    emailEl.textContent = signedIn ? `Signed in as ${email ?? 'owner'}` : 'Not signed in';
    action.textContent = signedIn ? 'Sign out' : 'Sign in with Google';
  };
  renderAccount();
  pill.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    pill.setAttribute('aria-expanded', String(!menu.hidden));
  });
  action.addEventListener('click', async () => {
    action.disabled = true;
    try {
      await (signedIn ? opts.onSignOut() : opts.onSignIn());
    } catch (err) {
      statusEl.textContent = err instanceof Error ? err.message : String(err);
    } finally {
      action.disabled = false;
    }
  });
  // Keep game keyboard input from reaching the canvas while using the menu.
  root.addEventListener('keydown', (e) => e.stopPropagation());
  document.body.appendChild(root);

  const update = (s: CloudStatus) => {
    last = s;
    root.dataset.state = s.state;
    const later = s.pending > 0 ? ` ${s.pending} change(s) will upload later.` : '';
    if (s.state === 'signed-out') {
      label.textContent = 'Saved on device';
      statusEl.textContent = (signedOutMessage ? `${signedOutMessage}. ` : '')
        + 'Progress is saved on this device.'
        + (s.pending > 0 ? ` Sign in to back up ${s.pending} change(s).` : '');
    } else if (s.state === 'offline') {
      label.textContent = 'Offline';
      statusEl.textContent = `Offline. Progress is saved on this device.${later}`;
    } else if (s.state === 'error') {
      label.textContent = 'Cloud sync retrying';
      statusEl.textContent = `Progress is saved on this device. Cloud sync failed (${s.message ?? 'unknown error'}) and will retry.${later}`;
    } else if (s.state === 'syncing') {
      label.textContent = 'Syncing…';
      statusEl.textContent = `Saved on this device. Syncing ${s.pending} change(s) to the cloud…`;
    } else {
      label.textContent = 'Cloud';
      statusEl.textContent = 'All progress is saved on this device and in the cloud.';
    }
  };

  return {
    update,
    setEmail(value) {
      email = value;
      renderAccount();
    },
    setSignedOut(message) {
      signedIn = false;
      signedOutMessage = message ? message.replace(/\.$/, '') : null;
      renderAccount();
      if (last) update(last);
    },
  };
}
