export interface StartupStatus {
  update(message: string): void;
  fail(message: string): void;
  remove(): void;
}

function projectDisplayName(projectPath: string): string {
  const rawName = projectPath.replace(/\.ltproj$/, '').replace(/_/g, ' ');
  return rawName === 'default'
    ? 'Default Campaign'
    : rawName.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Browser-native startup feedback layered over the canvas. */
export function installStartupStatus(projectPath: string): StartupStatus {
  document.getElementById('startup-status')?.remove();

  const root = document.createElement('section');
  root.id = 'startup-status';
  root.className = 'startup-status';
  root.setAttribute('aria-labelledby', 'startup-status-title');
  root.innerHTML = `
    <div class="startup-status__card">
      <p class="startup-status__eyebrow">Opening campaign</p>
      <h1 id="startup-status-title"></h1>
      <div class="startup-status__progress" aria-hidden="true"><span></span></div>
      <p class="startup-status__message" aria-live="polite">Preparing game data…</p>
      <div class="startup-status__actions" hidden>
        <button type="button" data-retry>Retry</button>
        <button type="button" data-campaigns>Choose another campaign</button>
      </div>
    </div>
  `;

  const title = root.querySelector<HTMLHeadingElement>('h1')!;
  const eyebrow = root.querySelector<HTMLElement>('.startup-status__eyebrow')!;
  const message = root.querySelector<HTMLElement>('.startup-status__message')!;
  const actions = root.querySelector<HTMLElement>('.startup-status__actions')!;
  const retry = root.querySelector<HTMLButtonElement>('[data-retry]')!;
  const campaigns = root.querySelector<HTMLButtonElement>('[data-campaigns]')!;

  title.textContent = projectDisplayName(projectPath);
  retry.addEventListener('click', () => window.location.reload());
  campaigns.addEventListener('click', () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('project');
    window.location.assign(url);
  });

  document.body.appendChild(root);

  let removed = false;
  return {
    update(nextMessage: string): void {
      if (!removed) message.textContent = nextMessage;
    },
    fail(error: string): void {
      if (removed) return;
      root.classList.add('startup-status--error');
      eyebrow.textContent = 'Unable to open campaign';
      title.textContent = 'Something went wrong';
      message.textContent = error;
      actions.hidden = false;
      retry.focus();
    },
    remove(): void {
      if (removed) return;
      removed = true;
      root.classList.add('startup-status--leaving');
      window.setTimeout(() => root.remove(), 180);
    },
  };
}
