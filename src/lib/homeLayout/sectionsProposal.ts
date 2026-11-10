/**
 * ==============================================================================
 * TREIDILOR — PORTADA EDITABLE · PROPUESTA DE BLOQUES DESDE LAS SECCIONES (etapa 2, solo en memoria)
 * ==============================================================================
 * Convierte las secciones PUBLICADAS de «Catálogo → Crear sección» en bloques de modalidad «Sección», reproduciendo la lógica con la que
 * `index.astro` las pinta hoy:
 *   1. sólo las publicadas;
 *   2. ordenadas por `order` ascendente (orden estable);
 *   3. con sus productos = `productIds` que existen en el catálogo;
 *   4. se descartan las que se quedan sin ningún producto;
 *   5. `position`: sólo «above» es «above» (cualquier otro valor = «below»); `speed` por defecto «normal».
 *
 * NO guarda nada ni modifica `sections.json`. La posición, la velocidad y el orden de la sección viajan como metadatos de la propuesta (el
 * modelo de bloques no cambia). Los bloques se validan con `validateBlock`: una propuesta nunca incumple el modelo.
 * ==============================================================================
 */

import type { Block } from './types';
import { validateBlock } from './validate';
import type { ReferenceSources, SectionInfo } from './sources';

export interface ProposedBlock {
  block: Block;
  section: { id: string; title: string; order: number; position: 'above' | 'below'; speed: SectionInfo['speed'] };
  /** Productos de la sección que existen en el catálogo, en su orden. */
  validProductIds: string[];
  /** Productos de la sección que ya no existen. */
  invalidProductIds: string[];
}

export interface SkippedSection {
  sectionId: string;
  reason: 'no_publicada' | 'sin_productos' | 'id_no_valido' | 'bloque_no_valido';
}

export interface SectionsProposal {
  proposed: ProposedBlock[];
  /** Mismo reparto que la portada actual: arriba y abajo del catálogo principal. */
  above: ProposedBlock[];
  below: ProposedBlock[];
  skipped: SkippedSection[];
}

const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** Id de bloque estable y válido derivado del de la sección; evita colisiones con un sufijo numérico. */
export function blockIdForSection(sectionId: string, used: Set<string>): string {
  const base = ('sec-' + sectionId.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '')).slice(0, 58) || 'sec';
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

export function buildSectionsProposal(src: ReferenceSources): SectionsProposal {
  const skipped: SkippedSection[] = [];
  const used = new Set<string>();
  // Array.prototype.sort es estable: el mismo criterio que index.astro (`a.order - b.order`).
  const ordered = [...src.sectionList].sort((a, b) => a.order - b.order);
  const proposed: ProposedBlock[] = [];

  for (const s of ordered) {
    if (!s.published) {
      skipped.push({ sectionId: s.id, reason: 'no_publicada' });
      continue;
    }
    const validProductIds = s.productIds.filter((pid) => src.products.has(pid));
    if (validProductIds.length === 0) {
      skipped.push({ sectionId: s.id, reason: 'sin_productos' });
      continue;
    }
    if (!/^[^\s<>"'`\\]{1,200}$/.test(s.id)) {
      skipped.push({ sectionId: s.id, reason: 'id_no_valido' });
      continue;
    }
    const candidate = {
      id: blockIdForSection(s.id, used),
      modality: 'seccion',
      format: 'carrusel',
      width: 12,
      title: (s.title || s.id).slice(0, 120),
      card: 'producto',
      config: {},
      refs: [{ kind: 'section', id: s.id }],
      visible: true,
    };
    const v = validateBlock(candidate);
    if (!v.ok || !SAFE_ID.test(candidate.id)) {
      skipped.push({ sectionId: s.id, reason: 'bloque_no_valido' });
      continue;
    }
    proposed.push({
      block: v.value,
      section: { id: s.id, title: s.title, order: s.order, position: s.position, speed: s.speed },
      validProductIds,
      invalidProductIds: s.productIds.filter((pid) => !src.products.has(pid)),
    });
  }
  return {
    proposed,
    above: proposed.filter((p) => p.section.position === 'above'),
    below: proposed.filter((p) => p.section.position !== 'above'),
    skipped,
  };
}
