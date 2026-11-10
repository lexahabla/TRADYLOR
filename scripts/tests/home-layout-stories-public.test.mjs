// Portada editable · etapa 6: seguridad de destinos e imágenes públicos e historias en la web pública (solo publicadas y válidas).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupIsolatedData } from './_helpers.mjs';

const dir = setupIsolatedData('treidilor-home-stories-public-');
delete process.env.HOME_LAYOUT_ENABLED;
const Safe = await import('../../src/lib/homeLayout/publicSafety.ts');
const Pub = await import('../../src/lib/homeLayout/public.ts');
const Sources = await import('../../src/lib/homeLayout/sources.ts');
const Stories = await import('../../src/lib/homeLayout/stories.ts');
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

fs.writeFileSync(`${dir}/products.json`, JSON.stringify([
  { id: 'p1', slug: 'p1-slug', title: 'P1', price: 10, category: 'Sonido', network: 'amazon', merchant: 'Amazon', currency: 'EUR', inStock: true, image: '/i.jpg', affiliateUrl: 'https://afiliado.example/secreto', sourceId: 'P1', extra: {} },
  { id: 'p2', slug: 'p2', title: 'P2', price: 20, category: 'Sonido', network: 'amazon', merchant: 'Amazon', currency: 'EUR', inStock: true, image: '/i.jpg', affiliateUrl: 'https://x/', sourceId: 'P2', extra: {} },
]));
fs.writeFileSync(`${dir}/categories.json`, JSON.stringify([{ id: 'sonido', name: 'Sonido', slug: 'sonido', icon: '🎧', keywords: [] }]));
fs.writeFileSync(`${dir}/sections.json`, '[]');
fs.writeFileSync(`${dir}/deleted-product-ids.json`, '[]');
const src = Sources.loadSources();

const screen = (id, over = {}) => ({ id, image: '/images/products/a.jpg', title: 'Título', text: 'Texto', buttonLabel: 'Ver', duration: 5, ...over });
const story = (id, over = {}) => ({ id, name: `Historia ${id}`, status: 'publicada', screens: [screen('p1')], ...over });
const exists = () => true;

test('rutas públicas: sólo propias, sin «..», sin codificar, y nunca zonas administrativas o técnicas', () => {
  for (const ok of ['/', '/guias/portatiles', '/?category=sonido', '/producto/p1', '/ofertas#top']) assert.equal(Safe.isPublicSafePath(ok), true, ok);
  for (const bad of ['', 'x', '//evil.example', '/a/../b', '/a/%2e%2e/b', '/%2E%2E/x', '/a\\b', '/a b', '/a"b', 'javascript:alert(1)',
    '/upayp1b4', '/upayp1b4/usuarios', '/UPAYP1B4/x', '/api/admin/x', '/api', '/api/redirect?id=1', '/out/abc', '/checkout/1', '/admin', '/_astro/x.js', '/_image?x=1', '/%75payp1b4', '/x'.repeat(200)]) {
    assert.equal(Safe.isPublicSafePath(bad), false, `debe rechazarse: ${bad}`);
  }
  assert.equal(Safe.isPublicSafePath(undefined), false);
});

test('imágenes públicas: extensiones de imagen, nada de vídeo, ni credenciales, puertos, IP o hosts internos', () => {
  for (const ok of ['/images/products/a.jpg', '/images/products/a.JPEG', '/x/y.webp', '/x/y.avif', '/x/y.gif', '/x/y.png?v=3', 'https://m.media-amazon.com/images/I/71abc._AC_SL1500_.jpg', 'https://img.example/x.png']) {
    assert.equal(Safe.isPublicSafeImage(ok), true, ok);
  }
  for (const bad of ['', '/images/products/v.mp4', '/images/products/v.webm', '/images/products/noext', '/images/../x.jpg', '/images/%2e%2e/x.jpg', '/api/x.jpg', '/upayp1b4/x.png',
    '//evil.example/x.png', 'http://img.example/x.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'https://user:pw@img.example/x.png', 'https://img.example:8443/x.png',
    'https://localhost/x.png', 'https://127.0.0.1/x.png', 'https://10.0.0.5/x.png', 'https://[::1]/x.png', 'https://intranet/x.png', 'https://nas.local/x.png', 'https://img.example/x.exe', 'https://img.example/x.svg', `https://img.example/${'a'.repeat(600)}.png`]) {
    assert.equal(Safe.isPublicSafeImage(bad), false, `debe rechazarse: ${bad.slice(0, 60)}`);
  }
  assert.equal(Safe.isPublicSafeExternalUrl('https://tienda.example/oferta'), true);
  for (const bad of ['http://tienda.example', 'https://localhost', 'https://u:p@x.example', 'ftp://x.example', 'javascript:1']) assert.equal(Safe.isPublicSafeExternalUrl(bad), false, bad);
});

test('checkStories (etapa 6): imagen no admisible y destino de campaña administrativo son ERRORES (no se pueden publicar); lo válido sigue igual', () => {
  const issues = (s) => Stories.checkStories([s], src);
  assert.ok(issues(story('a', { screens: [screen('p1', { image: '/images/products/v.mp4' })] })).some((i) => i.code === 'image_unsafe' && i.severity === 'error'));
  assert.ok(issues(story('a', { screens: [screen('p1', { image: 'https://localhost/x.png' })] })).some((i) => i.code === 'image_unsafe'));
  assert.ok(issues(story('a', { screens: [screen('p1', { link: { type: 'campaign', target: '/upayp1b4/usuarios' } })] })).some((i) => i.code === 'link_campaign_unsafe' && i.severity === 'error'));
  assert.ok(issues(story('a', { screens: [screen('p1', { link: { type: 'campaign', target: '/api/admin/x' } })] })).some((i) => i.code === 'link_campaign_unsafe'));
  const ok = issues(story('a', { screens: [screen('p1', { link: { type: 'campaign', target: '/guias/portatiles' } })] }));
  assert.equal(ok.filter((i) => i.severity === 'error').length, 0);
  assert.ok(ok.some((i) => i.code === 'link_campaign_unverified'));
  // los documentos ya guardados con esos valores NO dejan de validar (sólo se bloquea «publicada» y la web los omite)
  assert.ok(Stories.validateStories([story('a', { screens: [screen('p1', { image: '/images/products/v.mp4' })] })]).ok);
});

test('web pública: sólo historias publicadas y válidas; nunca borradores; destinos por id, sin enlace de afiliado', () => {
  const stories = [
    story('pub', { screens: [screen('p1', { link: { type: 'product', target: 'p1' } })] }),
    story('draft', { status: 'borrador' }),
    story('rota', { screens: [screen('p1', { link: { type: 'product', target: 'no-existe' } })] }),
    story('cat', { screens: [screen('p1', { link: { type: 'category', target: 'sonido' } })] }),
    story('camp', { screens: [screen('p1', { link: { type: 'campaign', target: '/guias/portatiles' } })] }),
  ];
  const out = Pub.publicStories(stories, src, exists);
  assert.deepEqual(out.map((s) => s.id), ['pub', 'cat', 'camp'], 'sin borrador y sin la historia con un producto inexistente');
  assert.equal(out[0].screens[0].href, '/producto/p1');
  assert.equal(out[1].screens[0].href, '/?category=sonido#destacados');
  assert.equal(out[2].screens[0].href, '/guias/portatiles');
  assert.equal(out[0].cover, '/images/products/a.jpg');
  assert.doesNotMatch(JSON.stringify(out), /afiliado|secreto|affiliate|upayp1b4/i);
});

test('web pública: pantallas con imagen inexistente o insegura se omiten; sin pantallas válidas la historia no aparece; botón sin destino válido se oculta', () => {
  const s = story('s', {
    screens: [
      screen('a', { image: '/images/products/falta.jpg' }),
      screen('b', { image: '/images/products/v.mp4' }),
      screen('c', { image: 'https://localhost/x.png' }),
      screen('d', { image: '/images/products/ok.jpg', link: { type: 'campaign', target: '/upayp1b4' } }),
      screen('e', { image: '/images/products/ok2.jpg', link: { type: 'product', target: 'p2' } }),
    ],
  });
  const only = (p) => p.endsWith('ok.jpg') || p.endsWith('ok2.jpg');
  const [r] = Pub.publicStories([s], src, only);
  // d: la historia entera tiene un error (destino administrativo) → no aparece
  assert.equal(r, undefined, 'una historia con un destino administrativo no se muestra');
  const s2 = story('s2', { screens: [screen('a', { image: '/images/products/falta.jpg' }), screen('e', { image: '/images/products/ok2.jpg', link: { type: 'product', target: 'p2' } })] });
  const [r2] = Pub.publicStories([s2], src, only);
  assert.equal(r2.screens.length, 1, 'la pantalla de imagen inexistente se omite');
  assert.equal(r2.cover, '/images/products/ok2.jpg');
  assert.equal(r2.screens[0].buttonLabel, 'Ver');
  assert.equal(Pub.publicStories([story('x', { screens: [screen('a', { image: '/images/products/falta.jpg' })] })], src, only).length, 0, 'sin pantallas válidas no aparece');
  // sin texto de botón o sin destino: nunca un botón vacío
  const s3 = story('s3', { screens: [screen('a', { buttonLabel: undefined, link: { type: 'product', target: 'p1' } })] });
  assert.equal(Pub.publicStories([s3], src, exists)[0].screens[0].href, undefined);
  assert.equal(Pub.localImageExists('/images/products/no-existe-nunca-xyz.jpg'), false);
  assert.equal(Pub.localImageExists('/../../etc/passwd'), false);
});

test('estático: el visor es un <dialog> accesible, escapa los datos y no hay redes sociales, analítica ni innerHTML', () => {
  const c = read('src/components/home/HomeStories.astro');
  assert.match(c, /<dialog/);
  assert.match(c, /showModal\(\)/);
  assert.match(c, /prefers-reduced-motion/);
  assert.match(c, /aria-label=\{`Ver historia: /);
  assert.match(c, /replace\(\/<\/g, '\\\\u003c'\)/, 'los datos JSON escapan «<»');
  assert.doesNotMatch(c, /innerHTML\s*=\s*[^'"]|eval\(|document\.write|instagram|facebook|tiktok|gtag|analytics|fetch\(/i);
  assert.doesNotMatch(c, /set:html=\{(?!json)/);
  const blocks = read('src/components/home/HomeLayoutBlocks.astro');
  assert.doesNotMatch(blocks, /set:html|affiliateUrl|buyNowUrl|innerHTML/);
  assert.match(blocks, /rel: 'noopener noreferrer nofollow'/);
  assert.doesNotMatch(code('src/lib/homeLayout/public.ts'), /affiliateUrl|buyNowUrl|commission|comision|writeFileSync|fs\.write|fs\.rename/);
});
