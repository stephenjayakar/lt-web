import type { GameButton, InputManager } from '../engine/input';

type VirtualInput = Pick<InputManager, 'pressVirtual' | 'releaseVirtual'>;
interface WebAudioControls {
  getMusicVolume(): number;
  getSfxVolume(): number;
  setMusicVolume(volume: number): void;
  setSfxVolume(volume: number): void;
  resume(): void;
}

function gameButton(label: string, button: GameButton, className: string): string {
  return `<button class="touch-controls__button ${className}" type="button" data-game-button="${button}" aria-label="${label}">${label}</button>`;
}

/**
 * Installs browser-native affordances around the canvas without changing the
 * engine's logical 240x160 rendering surface.
 */
export function installWebControls(input: VirtualInput, audio?: WebAudioControls): HTMLElement {
  document.getElementById('web-controls')?.remove();

  const root = document.createElement('div');
  root.id = 'web-controls';
  root.className = 'web-controls';
  root.innerHTML = `
    <div class="web-controls__utility">
      <button class="web-controls__utility-button" type="button" data-help aria-expanded="false" aria-controls="web-controls-panel">Controls</button>
      <button class="web-controls__utility-button" type="button" data-audio aria-label="Mute audio" aria-pressed="false">Sound on</button>
      <button class="web-controls__utility-button" type="button" data-fullscreen aria-label="Enter fullscreen">⛶</button>
    </div>
    <section class="web-controls__panel" id="web-controls-panel" aria-label="Game controls" hidden>
      <div class="web-controls__panel-header">
        <h2>How to play</h2>
        <button class="web-controls__close" type="button" data-close aria-label="Close controls">×</button>
      </div>
      <div class="web-controls__groups">
        <div class="web-controls__group">
          <h3>Keyboard</h3>
          <dl>
            <dt>Arrows / WASD</dt><dd>Move</dd>
            <dt>Z / Enter</dt><dd>Select</dd>
            <dt>X / Esc</dt><dd>Back</dd>
            <dt>C / Shift</dt><dd>Info</dd>
            <dt>V / Tab</dt><dd>Auxiliary</dd>
            <dt>Space</dt><dd>Start</dd>
          </dl>
        </div>
        <div class="web-controls__group">
          <h3>Pointer & touch</h3>
          <dl>
            <dt>Click / tap</dt><dd>Select</dd>
            <dt>Right-click</dt><dd>Back</dd>
            <dt>Drag</dt><dd>Pan map</dd>
            <dt>Wheel / pinch</dt><dd>Zoom</dd>
            <dt>Touch buttons</dt><dd>Full controls</dd>
          </dl>
        </div>
      </div>
    </section>
    <div class="touch-controls" aria-label="Touch game controls">
      <div class="touch-controls__dpad">
        ${gameButton('↑', 'UP', 'touch-controls__button--up')}
        ${gameButton('←', 'LEFT', 'touch-controls__button--left')}
        ${gameButton('→', 'RIGHT', 'touch-controls__button--right')}
        ${gameButton('↓', 'DOWN', 'touch-controls__button--down')}
      </div>
      <div class="touch-controls__actions">
        ${gameButton('Info', 'INFO', 'touch-controls__button--small')}
        ${gameButton('Menu', 'START', 'touch-controls__button--small')}
        ${gameButton('B', 'BACK', 'touch-controls__button--b')}
        ${gameButton('A', 'SELECT', 'touch-controls__button--a')}
      </div>
    </div>
  `;

  const helpButton = root.querySelector<HTMLButtonElement>('[data-help]')!;
  const panel = root.querySelector<HTMLElement>('#web-controls-panel')!;
  const closeButton = root.querySelector<HTMLButtonElement>('[data-close]')!;
  const audioButton = root.querySelector<HTMLButtonElement>('[data-audio]')!;
  const fullscreenButton = root.querySelector<HTMLButtonElement>('[data-fullscreen]')!;
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  let priorMusicVolume = audio?.getMusicVolume() ?? 0.7;
  let priorSfxVolume = audio?.getSfxVolume() ?? 1;

  const setHelpOpen = (open: boolean): void => {
    panel.hidden = !open;
    helpButton.setAttribute('aria-expanded', String(open));
    if (open) closeButton.focus();
  };

  helpButton.addEventListener('click', () => setHelpOpen(panel.hidden));
  closeButton.addEventListener('click', () => {
    setHelpOpen(false);
    canvas?.focus({ preventScroll: true });
  });

  audioButton.addEventListener('click', () => {
    if (!audio) return;
    const muted = audio.getMusicVolume() === 0 && audio.getSfxVolume() === 0;
    if (muted) {
      audio.setMusicVolume(priorMusicVolume);
      audio.setSfxVolume(priorSfxVolume);
      audio.resume();
    } else {
      priorMusicVolume = audio.getMusicVolume();
      priorSfxVolume = audio.getSfxVolume();
      audio.setMusicVolume(0);
      audio.setSfxVolume(0);
    }
    const nextMuted = !muted;
    audioButton.textContent = nextMuted ? 'Muted' : 'Sound on';
    audioButton.setAttribute('aria-label', nextMuted ? 'Unmute audio' : 'Mute audio');
    audioButton.setAttribute('aria-pressed', String(nextMuted));
  });

  fullscreenButton.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // Fullscreen is optional and may be disallowed by an embedding browser.
    }
    canvas?.focus({ preventScroll: true });
  });

  document.addEventListener('fullscreenchange', () => {
    const active = !!document.fullscreenElement;
    fullscreenButton.setAttribute('aria-label', active ? 'Exit fullscreen' : 'Enter fullscreen');
  });

  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-game-button]')) {
    const gameInput = button.dataset.gameButton as GameButton;
    const press = (event: Event): void => {
      event.preventDefault();
      button.dataset.pressed = 'true';
      input.pressVirtual(gameInput);
    };
    const release = (event: Event): void => {
      event.preventDefault();
      delete button.dataset.pressed;
      input.releaseVirtual(gameInput);
      canvas?.focus({ preventScroll: true });
    };

    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('pointerleave', (event) => {
      if (button.dataset.pressed === 'true') release(event);
    });
    button.addEventListener('click', (event) => {
      if (event.detail !== 0) return;
      press(event);
      window.setTimeout(() => input.releaseVirtual(gameInput), 0);
    });
  }

  document.body.appendChild(root);
  return root;
}
