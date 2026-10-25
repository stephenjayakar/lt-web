// Browser chrome for cloud saves: the sign-in gate shown before the game
// boots, and a small account/sync pill (sync status, sign out) while playing.

import type { CloudStatus } from './cloud-store';

export interface SignInOptions {
  error: string | null;
  fakeLogin: boolean;
  onGoogle(): Promise<void>;
  onFake(email: string, secret: string): Promise<void>;
}

const ROOT_ID = 'cloud-signin';

/** Blocking status card (loading cloud saves, offline, etc.). */
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

/** The sign-in gate. Resolves after a successful (fake) sign-in; Google navigates away. */
export function showSignIn(opts: SignInOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    const root = ensureRoot();
    root.innerHTML = `
      <main class="project-picker__card cloud-signin__card">
        <p class="project-picker__eyebrow">Lex Talionis · Web Player</p>
        <h1>Sign in to play</h1>
        <p class="project-picker__lede">Saves, records, and achievements are stored in the cloud for the owner's Google account.</p>
        <button type="button" class="cloud-signin__google" data-google>Sign in with Google</button>
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
          resolve();
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

/** Account + sync pill. Returns a status updater. */
export function installAccountPill(email: string, onSignOut: () => void): (s: CloudStatus) => void {
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
      <button type="button" data-signout>Sign out</button>
    </div>`;
  const pill = root.querySelector<HTMLButtonElement>('.cloud-account__pill')!;
  const menu = root.querySelector<HTMLElement>('.cloud-account__menu')!;
  const label = root.querySelector<HTMLElement>('.cloud-account__label')!;
  const statusEl = root.querySelector<HTMLElement>('.cloud-account__status')!;
  root.querySelector('.cloud-account__email')!.textContent = `Signed in as ${email}`;
  pill.addEventListener('click', () => {
    menu.hidden = !menu.hidden;
    pill.setAttribute('aria-expanded', String(!menu.hidden));
  });
  root.querySelector('[data-signout]')!.addEventListener('click', () => onSignOut());
  // Keep game keyboard input from reaching the canvas while using the menu.
  root.addEventListener('keydown', (e) => e.stopPropagation());
  document.body.appendChild(root);

  return (s: CloudStatus) => {
    root.dataset.state = s.state;
    if (s.state === 'error') {
      label.textContent = 'Sync failed — retrying';
      statusEl.textContent = `${s.pending} change(s) not yet saved to the cloud: ${s.message ?? 'unknown error'}`;
    } else if (s.state === 'syncing') {
      label.textContent = 'Saving…';
      statusEl.textContent = `Saving ${s.pending} change(s) to the cloud…`;
    } else {
      label.textContent = 'Cloud';
      statusEl.textContent = 'All progress is saved to the cloud.';
    }
  };
}
