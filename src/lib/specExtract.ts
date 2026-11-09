/**
 * ==============================================================================
 * TREIDILOR — ESPECIFICACIONES DESDE EL TÍTULO (lectura, no escribe nada)
 * ==============================================================================
 * Cuando la ficha no declara una característica (o la declara de forma inservible: «330», «SSD»), muchos títulos la traen:
 * «Lenovo IdeaPad Slim 3 Intel Core i5, 16GB, 1TB, W11», «Portátil 15,6" Ryzen 5 8GB 512GB SSD»…
 * Estos extractores sólo reconocen patrones inequívocos; si no hay patrón claro devuelven null (nunca se inventa un valor). El comparador marca
 * estos datos como «del título» para que no se confundan con los declarados por la ficha.
 * ==============================================================================
 */

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const num = (s: string) => s.replace(',', '.');

interface Capacity { value: number; unit: 'GB' | 'TB'; tail: string; index: number }

function capacities(title: string): Capacity[] {
  const out: Capacity[] = [];
  const re = /(\d{1,4}(?:[.,]\d)?)\s?(TB|GB)\b\s*(SSD|NVMe|eMMC|HDD|DDR\d\w*|RAM|LPDDR\w*)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(title))) out.push({ value: Number(num(m[1])), unit: m[2].toUpperCase() as 'GB' | 'TB', tail: (m[3] ?? '').toUpperCase(), index: m.index });
  return out;
}

const gb = (c: Capacity) => (c.unit === 'TB' ? c.value * 1024 : c.value);
const fmtCap = (c: Capacity, withTail = true) => `${String(c.value).replace('.', ',')} ${c.unit}${withTail && /SSD|NVME|EMMC|HDD/.test(c.tail) ? ' ' + c.tail.replace('NVME', 'NVMe').replace('EMMC', 'eMMC') : ''}`;

/** RAM: capacidad marcada como RAM/DDR o, si hay varias, la menor (≤ 128 GB). */
export function ramFromTitle(title: string): string | null {
  const caps = capacities(title).filter((c) => c.unit === 'GB' && c.value <= 128);
  const marked = caps.find((c) => /RAM|DDR|LPDDR/.test(c.tail));
  if (marked) return fmtCap(marked, false);
  const storage = storageCandidate(title);
  const rest = caps.filter((c) => c !== storage);
  if (rest.length) return fmtCap(rest.sort((a, b) => a.value - b.value)[0], false);
  // Un único «16GB» sin más contexto en un ordenador suele ser RAM sólo si hay además almacenamiento en TB.
  return null;
}

function storageCandidate(title: string): Capacity | null {
  const caps = capacities(title).filter((c) => !/RAM|DDR|LPDDR/.test(c.tail));
  const marked = caps.find((c) => /SSD|NVME|EMMC|HDD/.test(c.tail));
  if (marked) return marked;
  const big = caps.filter((c) => c.unit === 'TB' || gb(c) >= 128).sort((a, b) => gb(b) - gb(a));
  return big[0] ?? null;
}

/** Almacenamiento: capacidad con SSD/NVMe/HDD o la mayor (TB o ≥ 128 GB). */
export function storageFromTitle(title: string): string | null {
  const c = storageCandidate(title);
  return c ? fmtCap(c) : null;
}

/** Procesador: Intel Core / Core Ultra / Ryzen / Apple M-series / Snapdragon X / Celeron / Pentium / Intel N-series. */
export function cpuFromTitle(title: string): string | null {
  const patterns: RegExp[] = [
    /\b(?:Intel\s+)?Core\s+Ultra\s+[3579]\s?\w{0,6}/i,
    /\b(?:Intel\s+)?Core\s+[3579]\s+\d{3}\w?/i,
    /\b(?:Intel\s+)?Core\s+i[3579](?:[-\s]\d{4,5}\w{0,3})?/i,
    /\b(?:AMD\s+)?Ryzen\s+(?:AI\s+)?[3579]\s?\d{0,5}\w{0,3}/i,
    /\bApple\s+M\d(?:\s?(?:Pro|Max|Ultra))?/i,
    /\bchip\s+M\d(?:\s?(?:Pro|Max|Ultra))?/i,
    /\bM[1-9](?:\s(?:Pro|Max|Ultra))?\b(?!\w)/,
    /\bSnapdragon\s+X\s?\w*(?:\s?Elite|\s?Plus)?/i,
    /\bIntel\s+(?:Celeron|Pentium)\s?\w*/i,
    /\b(?:Celeron|Pentium)\s?\w*/i,
    /\bIntel\s+N\d{2,3}\b/i,
    /\bMediaTek\s+\w+/i,
    /\bExynos\s+\w+/i,
    /\bSnapdragon\s+\d\w*/i,
  ];
  for (const re of patterns) {
    const m = title.match(re);
    if (m) return clean(m[0]);
  }
  return null;
}

/** Pantalla en pulgadas: 15,6" · 13 pulgadas · 14 inch. */
export function screenFromTitle(title: string): string | null {
  const m = title.match(/(\d{2}(?:[.,]\d{1,2})?)\s?(?:"|''|”|″|pulgadas?|inch(?:es)?|in\b)/i);
  if (!m) return null;
  const v = Number(num(m[1]));
  if (!(v >= 5 && v <= 100)) return null;
  return `${String(v).replace('.', ',')}"`;
}

/** Gráfica: RTX/GTX/Radeon/Iris Xe/Arc. */
export function gpuFromTitle(title: string): string | null {
  const m = title.match(/\b(?:NVIDIA\s+)?(?:GeForce\s+)?(?:RTX|GTX)\s?\d{3,4}\w{0,3}(?:\s?Ti)?|\bRadeon\s+(?:RX\s?)?\w{2,6}|\bIris\s+Xe\b|\bIntel\s+Arc\b/i);
  return m ? clean(m[0]) : null;
}

/** Bluetooth 5.3, etc. */
export function bluetoothFromTitle(title: string): string | null {
  const m = title.match(/Bluetooth\s?(\d(?:\.\d)?)/i);
  return m ? `Bluetooth ${m[1]}` : null;
}

/** Autonomía declarada en el título: «72H», «40 horas». */
export function autonomyFromTitle(title: string): string | null {
  const m = title.match(/(?:^|[^\w.])(\d{1,3})\s?(?:h|horas)\b/i);
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 2 && v <= 300 ? `${v} h` : null;
}

/** Resolución habitual en títulos: 2K, 4K, 1920x1080, FHD, QHD. */
export function resolutionFromTitle(title: string): string | null {
  const m = title.match(/\b(\d{3,4})\s?[x×]\s?(\d{3,4})\b|\b(4K|2K|FHD|QHD|UHD|WUXGA|WQXGA)\b/i);
  if (!m) return null;
  return m[1] ? `${m[1]} × ${m[2]}` : m[3].toUpperCase();
}

export const TITLE_EXTRACTORS: Record<string, (title: string) => string | null> = {
  ram: ramFromTitle,
  storage: storageFromTitle,
  cpu: cpuFromTitle,
  screen: screenFromTitle,
  gpu: gpuFromTitle,
  connectivity: bluetoothFromTitle,
  autonomy: autonomyFromTitle,
  resolution: resolutionFromTitle,
};
