import fs from 'node:fs';
import path from 'node:path';
import { dataFile } from './paths';

const FILE = dataFile('sections.json');

export type SectionSpeed = 'slow' | 'normal' | 'fast' | 'none';

export interface WebSection {
  id: string;
  title: string;
  description?: string;
  productIds: string[];
  published: boolean;
  order: number;
  /** 'above' = por encima del catálogo principal; 'below' = por debajo. */
  position?: 'above' | 'below';
  /** Velocidad de desplazamiento automático: 'slow' (~20px/s), 'normal' (~36px/s), 'fast' (~65px/s), 'none' (pausado). */
  speed?: SectionSpeed;
  createdAt: string;
}

export function readSections(): WebSection[] {
  try {
    if (!fs.existsSync(FILE)) return [];
    const raw = fs.readFileSync(FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('[Sections] Error al leer sections.json:', error);
    return [];
  }
}

function writeSections(sections: WebSection[]): boolean {
  try {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(sections, null, 2), 'utf-8');
    return true;
  } catch (error) {
    console.error('[Sections] Error al escribir sections.json:', error);
    return false;
  }
}

export function slugifySection(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '')
    .slice(0, 50);
  return base || `seccion-${Date.now().toString(36)}`;
}

export function upsertSection(section: WebSection): boolean {
  const sections = readSections();
  const idx = sections.findIndex((s) => s.id === section.id);
  if (idx >= 0) sections[idx] = section;
  else sections.push(section);
  sections.sort((a, b) => a.order - b.order);
  return writeSections(sections);
}

export function deleteSection(id: string): boolean {
  const sections = readSections().filter((s) => s.id !== id);
  return writeSections(sections);
}

export function findSection(id: string): WebSection | undefined {
  return readSections().find((s) => s.id === id);
}
