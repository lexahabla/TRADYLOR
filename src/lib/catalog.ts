import fs from 'node:fs';
import path from 'node:path';
import { products as staticProducts, type Product } from '../data/products';

const DATA_FILE_PATH = path.join(process.cwd(), 'src', 'data', 'products.json');

export function getCatalogProducts(): Product[] {
  let jsonProducts: Product[] = [];

  try {
    if (fs.existsSync(DATA_FILE_PATH)) {
      const raw = fs.readFileSync(DATA_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) jsonProducts = parsed as Product[];
    }
  } catch (error) {
    console.error('[Catalog] Error al leer products.json:', error);
  }

  return [
    ...jsonProducts,
    ...staticProducts.filter((staticProduct) => !jsonProducts.some((jsonProduct) => jsonProduct.id === staticProduct.id)),
  ];
}