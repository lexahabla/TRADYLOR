/**
 * ==============================================================================
 * TRADYLOR — PANEL DE COMPARTIR (inyectado en cualquier página)
 * ==============================================================================
 * Modal reutilizable que se monta una sola vez en <body> y se abre desde el
 * drawer del header o desde las tarjetas de Mi Radar. Todo el markup/estilos
 * van aquí dentro (no pasan por el scoping de Astro).
 * ==============================================================================
 */

import {
  getShareLang,
  getShareLangOptions,
  setShareLang,
  shareLabel,
  sharePanelTitle,
  shareTo,
  type ShareChannel,
  type ShareInput,
  type ShareLangCode,
} from './share';

const CHANNELS: ShareChannel[] = [
  'whatsapp',
  'telegram',
  'x',
  'facebook',
  'reddit',
  'instagram',
  'pinterest',
  'tiktok',
  'email',
  'copy',
  'native',
];

const ICONS: Record<ShareChannel, string> = {
  whatsapp:
    '<path d="M20.5 3.5A11 11 0 0 0 3.2 17.1L2 22l5-1.3A11 11 0 1 0 20.5 3.5Z" fill="currentColor" stroke="none"/><path d="M8.6 7.8c.3 0 .6 0 .8.5l.8 1.9c.1.3 0 .5-.2.7l-.5.5c-.2.2-.2.4-.1.6a7.4 7.4 0 0 0 3.6 3.2c.2.1.4.1.6-.1l.6-.6c.2-.2.4-.2.7-.1l1.9.8c.4.2.5.4.5.7 0 1-.8 1.7-1.8 1.7a9 9 0 0 1-8.3-8.4c0-1 .7-1.7 1.5-1.7Z" fill="#0d1422" stroke="none"/>',
  telegram:
    '<path d="M21.5 4.2 2.9 11.4c-.9.4-.9 1 .1 1.3l4.7 1.5 1.8 5.5c.2.6.4.8.9.8.4 0 .6-.2.9-.5l2.4-2.3 4.7 3.5c.9.5 1.5.2 1.7-.8l3-14c.2-1-.4-1.5-1.5-1.2ZM8.9 14.7l9.4-5.9c.4-.3.8-.1.5.2l-7.7 7-.3 3.2-1.9-4.5Z" fill="currentColor" stroke="none"/>',
  x: '<path d="M17.5 3h3l-6.6 7.5L21.8 21h-6l-4.7-6.1L5.7 21H2.6l7-8L2.3 3h6.2l4.2 5.6L17.5 3Zm-1 16h1.7L7.6 4.7H5.8L16.5 19Z" fill="currentColor" stroke="none"/>',
  facebook:
    '<path d="M14 9h3V6h-3c-2.2 0-4 1.8-4 4v2H7v3h3v6h3v-6h3l1-3h-4v-2c0-.6.4-1 1-1Z" fill="currentColor" stroke="none"/>',
  reddit:
    '<circle cx="12" cy="13" r="7" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="9.5" cy="12.5" r="1.1" fill="currentColor"/><circle cx="14.5" cy="12.5" r="1.1" fill="currentColor"/><path d="M9.5 15.6c1.5 1 3.5 1 5 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13 6.5l1-2.6 2.6.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="17.4" cy="4.8" r="1.4" fill="currentColor"/>',
  instagram:
    '<rect x="3.5" y="3.5" width="17" height="17" rx="5" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="3.8" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="17" cy="7" r="1.2" fill="currentColor"/>',
  pinterest:
    '<path d="M12 3a9 9 0 0 0-3.3 17.4c-.1-.7-.2-1.9 0-2.7l1.1-4.7s-.3-.6-.3-1.4c0-1.3.8-2.3 1.7-2.3.8 0 1.2.6 1.2 1.4 0 .8-.5 2.1-.8 3.3-.2.9.5 1.7 1.4 1.7 1.7 0 2.9-2.2 2.9-4.7 0-1.9-1.3-3.4-3.7-3.4a4.3 4.3 0 0 0-4.5 4.3c0 .9.3 1.5.7 2 .2.2.2.3.1.6l-.2.8c-.1.3-.3.4-.6.2-1.1-.5-1.7-2-1.7-3.6 0-2.7 2.3-5.9 6.7-5.9 3.6 0 6 2.6 6 5.4 0 3.7-2 6.4-5 6.4-1 0-2-.5-2.3-1.2l-.6 2.4c-.2.8-.7 1.7-1.1 2.3A9 9 0 1 0 12 3Z" fill="currentColor" stroke="none"/>',
  tiktok:
    '<path d="M16.5 3c.4 2 1.6 3.4 3.5 3.7v3c-1.4 0-2.7-.4-3.9-1.2v5.9c0 3.4-2.7 6.1-6.1 6.1S4 17.8 4 14.4s2.7-6.1 6.1-6.1c.3 0 .6 0 .9.1v3.1a3 3 0 1 0 2.1 2.9V3h3.4Z" fill="currentColor" stroke="none"/>',
  email:
    '<rect x="3" y="5.5" width="18" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m4.5 8 7.5 5 7.5-5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3H6a2.5 2.5 0 0 0-2.5 2.5V12A2.5 2.5 0 0 0 6 14.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  native: '<path d="M12 3v11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="m8 7 4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
};

const STYLES = `
  .tz-share-root{position:fixed;inset:0;z-index:9999;display:none;align-items:center;justify-content:center;padding:1rem}
  .tz-share-root.is-open{display:flex}
  .tz-share-backdrop{position:absolute;inset:0;background:rgba(3,7,18,.72);backdrop-filter:blur(3px)}
  .tz-share-panel{position:relative;width:min(420px,100%);background:#111827;border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:1.25rem;box-shadow:0 24px 60px rgba(0,0,0,.55);font-family:Inter,system-ui,Arial,sans-serif;color:#f3f4f6}
  .tz-share-head{display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem;margin-bottom:.35rem}
  .tz-share-title{margin:0;font-size:1rem;font-weight:800;letter-spacing:-.01em}
  .tz-share-sub{margin:0 0 .75rem;font-size:.78rem;color:#9ca3af;line-height:1.45;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
  .tz-share-langs{display:flex;gap:.35rem;flex-wrap:wrap;margin:0 0 .9rem;padding:.28rem;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:999px;width:fit-content;max-width:100%}
  .tz-share-lang{padding:.34rem .72rem;font-family:inherit;font-size:.72rem;font-weight:700;color:#9ca3af;background:transparent;border:1px solid transparent;border-radius:999px;cursor:pointer;transition:.16s;white-space:nowrap}
  .tz-share-lang:hover{color:#e5e7eb;background:rgba(255,255,255,.06)}
  .tz-share-lang.is-active{color:#0d1422;background:linear-gradient(135deg,#60a5fa 0%,#3b82f6 100%);border-color:rgba(96,165,250,.6);box-shadow:0 4px 12px rgba(59,130,246,.35)}
  .tz-share-lang:focus-visible{outline:2px solid #60a5fa;outline-offset:1px}
  .tz-share-close{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:#e5e7eb;width:32px;height:32px;border-radius:9px;font-size:1rem;line-height:1;cursor:pointer;flex:0 0 auto}
  .tz-share-close:hover{background:rgba(255,255,255,.14)}
  .tz-share-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:.5rem}
  .tz-share-opt{display:flex;flex-direction:column;align-items:center;gap:.35rem;padding:.65rem .3rem;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:12px;color:#e5e7eb;cursor:pointer;font-family:inherit;font-size:.66rem;font-weight:600;transition:.15s}
  .tz-share-opt:hover{background:rgba(59,130,246,.16);border-color:rgba(59,130,246,.5);transform:translateY(-1px)}
  .tz-share-opt svg{width:20px;height:20px}
  .tz-share-opt[data-channel="whatsapp"]{color:#25d366}
  .tz-share-opt[data-channel="telegram"]{color:#29a9eb}
  .tz-share-opt[data-channel="instagram"]{color:#e1306c}
  .tz-share-opt[data-channel="pinterest"]{color:#e60023}
  .tz-share-opt[data-channel="tiktok"]{color:#f3f4f6}
  .tz-share-toast{position:absolute;left:50%;bottom:-2.9rem;transform:translateX(-50%) translateY(6px);opacity:0;background:#0d1422;border:1px solid rgba(255,255,255,.16);color:#f3f4f6;padding:.55rem .9rem;border-radius:999px;font-size:.76rem;white-space:nowrap;pointer-events:none;transition:.2s}
  .tz-share-toast.is-on{opacity:1;transform:translateX(-50%) translateY(0)}
  @media (max-width:420px){.tz-share-grid{grid-template-columns:repeat(3,1fr)}}
`;

let root: HTMLDivElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function ensureRoot(): HTMLDivElement {
  if (root && document.body.contains(root)) return root;

  const style = document.createElement('style');
  style.setAttribute('data-tz-share', 'true');
  style.textContent = STYLES;
  document.head.appendChild(style);

  root = document.createElement('div');
  root.className = 'tz-share-root';
  root.setAttribute('data-tz-share-root', 'true');
  root.innerHTML = `
    <div class="tz-share-backdrop" data-share-close></div>
    <div class="tz-share-panel" role="dialog" aria-modal="true" aria-labelledby="tzShareTitle">
      <div class="tz-share-head">
        <div style="min-width:0">
          <p class="tz-share-title" id="tzShareTitle">Compartir producto</p>
        </div>
        <button type="button" class="tz-share-close" data-share-close aria-label="Cerrar">×</button>
      </div>
      <p class="tz-share-sub" data-share-subtitle></p>
      <div class="tz-share-langs" data-share-langs role="group" aria-label="Idioma del mensaje"></div>
      <div class="tz-share-grid" data-share-grid></div>
      <div class="tz-share-toast" data-share-toast></div>
    </div>
  `;
  document.body.appendChild(root);

  renderLangs();
  renderChannels();

  root.addEventListener('click', (event) => {
    const target = event.target as Element | null;
    if (!target) return;
    if (target.closest('[data-share-close]')) {
      close();
      return;
    }
    const lang = target.closest<HTMLElement>('[data-lang]');
    if (lang?.dataset.lang) {
      setShareLang(lang.dataset.lang as ShareLangCode);
      renderLangs();
      renderChannels();
      return;
    }
    const opt = target.closest<HTMLElement>('[data-channel]');
    if (opt?.dataset.channel) void runShare(opt.dataset.channel as ShareChannel);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });

  return root;
}

/** Selector de idioma: detectado por región + inglés + chino (siempre). */
function renderLangs(): void {
  const box = root?.querySelector('[data-share-langs]');
  if (!box) return;
  const active = getShareLang();
  box.innerHTML = getShareLangOptions()
    .map(
      (option) => `
      <button type="button" class="tz-share-lang${option.code === active ? ' is-active' : ''}"
        data-lang="${option.code}" aria-pressed="${option.code === active}">${option.label}</button>`,
    )
    .join('');
}

/** Re-pinta título y etiquetas de canal según el idioma elegido. */
function renderChannels(): void {
  const title = root?.querySelector('#tzShareTitle');
  if (title) title.textContent = sharePanelTitle();
  const grid = root?.querySelector('[data-share-grid]');
  if (!grid) return;
  grid.innerHTML = CHANNELS.map(
    (channel) => `
    <button type="button" class="tz-share-opt" data-channel="${channel}">
      <svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[channel]}</svg>
      <span>${shareLabel(channel)}</span>
    </button>`,
  ).join('');
}

let current: ShareInput | null = null;

function showToast(message: string, error = false): void {
  const toast = root?.querySelector<HTMLElement>('[data-share-toast]');
  if (!toast) return;
  toast.textContent = message;
  toast.style.borderColor = error ? 'rgba(248,113,113,.6)' : 'rgba(255,255,255,.16)';
  toast.style.color = error ? '#fca5a5' : '#f3f4f6';
  toast.classList.add('is-on');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('is-on'), 2600);
}

async function runShare(channel: ShareChannel): Promise<void> {
  if (!current) return;
  const result = await shareTo(channel, current);
  if (result.message) showToast(result.message, !result.ok);
  if (result.ok && channel !== 'copy' && result.mode === 'opened') close();
}

function close(): void {
  root?.classList.remove('is-open');
  current = null;
}

/** Abre el panel de compartir para un producto. */
export function openSharePanel(input: ShareInput): void {
  const el = ensureRoot();
  current = input;
  renderLangs();
  renderChannels();
  const subtitle = el.querySelector('[data-share-subtitle]');
  if (subtitle) {
    subtitle.textContent = input.title || 'Este producto';
  }
  el.classList.add('is-open');
}
