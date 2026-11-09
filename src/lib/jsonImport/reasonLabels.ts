/**
 * Motivos de revisión/rechazo del motor de importación en lenguaje comprensible para el administrador.
 * Los códigos (`reasons`) NO cambian (son contrato de los informes y de la cola de revisión); esto sólo los traduce para mostrarlos.
 * Una variante con detalle («moneda_distinta:EUR≠USD») se explica con ese detalle.
 */

const FIXED: Record<string, string> = {
  anuncio_en_varias_fichas: 'Este anuncio ya está en varias fichas: no se sabe a cuál pertenece, así que no se ha tocado ninguna',
  anuncio_repetido_en_lote: 'El mismo anuncio aparece repetido en este lote',
  condicion_no_verificable: 'No se puede confirmar la condición (nuevo, usado, abierto…): el registro y la ficha no coinciden en si la declaran',
  vendedor_no_confirmado: 'El anuncio ya tiene ofertas registradas y el registro no indica el vendedor',
  vendedor_no_confirmado_varias_ofertas: 'El anuncio tiene varias ofertas y el registro no indica a cuál de los vendedores corresponde',
  identificadores_contradictorios: 'Los identificadores del registro se contradicen entre sí',
  gtin_contradictorio: 'El GTIN del registro es distinto del de la ficha',
  mpn_contradictorio: 'La referencia del fabricante (MPN) es distinta de la de la ficha',
  titulo_incompatible_con_el_producto_existente: 'El título apunta a otro modelo distinto del de la ficha',
  titulo_parecido_con_identificadores_contradictorios: 'Título casi idéntico al de una ficha, pero con GTIN, referencia o marca distintos: podría ser otro producto',
  titulo_parecido_sin_identificador_fuerte: 'Título muy parecido a una ficha existente, sin identificador que lo confirme',
  gtin_varias_fichas: 'El GTIN coincide con varias fichas',
  marca_mpn_varias_fichas: 'Marca y referencia coinciden con varias fichas',
  gtin_atributos_en_conflicto: 'Mismo GTIN pero variante distinta (capacidad, talla, color…)',
  marca_mpn_atributos_en_conflicto: 'Misma marca y referencia pero variante distinta',
  sin_categoria: 'Sin categoría: queda en revisión hasta que se asigne una',
  ya_existe_omitido: 'Ya existe en el catálogo: omitido',
};

const VARIANT_KEY: Record<string, string> = { color: 'color', size: 'talla', capacity: 'capacidad', pack: 'cantidad/pack' };
const CONDITION: Record<string, string> = { new: 'nuevo', used: 'usado', refurbished: 'reacondicionado', open_box: 'abierto, sin usar', unknown: 'sin indicar' };

export function explainReason(code: string): string {
  if (FIXED[code]) return FIXED[code];
  const [head, ...rest] = code.split(':');
  const detail = rest.join(':');
  switch (head) {
    case 'moneda_distinta': {
      const [a, b] = detail.split('≠');
      return `Moneda distinta: la ficha está en ${a} y el registro en ${b}. No se convierte ni se actualiza solo`;
    }
    case 'condicion_distinta': {
      const [a, b] = detail.split('≠');
      return `Condición distinta: la ficha es «${CONDITION[a] ?? a}» y el registro «${CONDITION[b] ?? b}»`;
    }
    case 'variante_distinta':
      return `Variante distinta (${VARIANT_KEY[detail] ?? detail}): es otra versión del producto`;
    case 'variante_no_verificable':
      return `No se puede confirmar la variante (${VARIANT_KEY[detail] ?? detail}): sólo uno de los dos la indica`;
    case 'cantidad_distinta':
      return 'Cantidad o pack distinto: no es el mismo artículo';
    case 'cantidad_no_verificable':
      return 'No se puede confirmar la cantidad o el pack: sólo uno de los dos la indica';
    case 'marca_contradictoria': {
      const [a, b] = detail.split('≠');
      return `Marca distinta: la ficha es «${a}» y el registro «${b}»`;
    }
    case 'anuncio_con_vendedor_distinto': {
      const [a, b] = detail.split('≠');
      return `Este anuncio pertenece a otro vendedor (${a}) y el registro dice ${b}: en esta tienda un anuncio tiene un solo vendedor`;
    }
    case 'anuncio_repetido_en_lote_con_precio_distinto': {
      const [a, b] = detail.split('≠');
      return `El anuncio aparece repetido en este lote con precios distintos (${a} y ${b}): se conserva el primero y éste queda en revisión`;
    }
    case 'id': // «identificadores_contradictorios» con detalle: «id=X ≠ url=Y»
      return `El identificador declarado no coincide con el de su enlace (${code})`;
    default:
      return code;
  }
}

export const explainReasons = (codes: string[]): string[] => codes.map(explainReason);
