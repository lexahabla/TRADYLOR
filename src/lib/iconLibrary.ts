/**
 * ==============================================================================
 * TREIDILOR — BIBLIOTECA DE ICONOS PARA CATEGORÍAS Y GENERADOR DE PALABRAS CLAVE
 * ==============================================================================
 * Local, sin red ni IA. Al escribir una palabra en «Icono (emoji)» del panel de categorías,
 * `searchIcons` propone los emojis relacionados y `suggestKeywords` genera las palabras clave
 * (la palabra, sus variantes con/sin tilde y singular/plural, y los términos del icono elegido).
 * Cada entrada: [emoji, etiqueta, palabras relacionadas separadas por coma].
 * ==============================================================================
 */

export interface IconEntry {
  emoji: string;
  label: string;
  words: string[];
}

const RAW: Array<[string, string, string]> = [
  // Informática y tecnología
  ['💻', 'Portátil', 'portatil, portátil, laptop, ordenador, notebook, macbook, chromebook, informática, informatica'],
  ['🖥️', 'Ordenador de sobremesa', 'ordenador, sobremesa, pc, monitor, pantalla, torre, escritorio, informática'],
  ['⌨️', 'Teclado', 'teclado, teclado mecánico, teclado mecanico, keyboard, periféricos, perifericos'],
  ['🖱️', 'Ratón', 'raton, ratón, mouse, periféricos, perifericos, trackball'],
  ['🖨️', 'Impresora', 'impresora, imprimir, escáner, escaner, tinta, tóner, toner, oficina'],
  ['💾', 'Almacenamiento', 'ssd, disco duro, hdd, nvme, almacenamiento, memoria, pendrive, usb, tarjeta sd, microsd'],
  ['🔌', 'Cables y conectores', 'cable, cables, conector, adaptador, hdmi, usb, enchufe, regleta, alargador, cargador'],
  ['🔋', 'Baterías', 'bateria, batería, pila, pilas, powerbank, power bank, batería externa, recargable, energía'],
  ['📶', 'Redes y WiFi', 'wifi, router, red, redes, repetidor, switch, ethernet, módem, modem, mesh, internet'],
  ['🧠', 'Componentes', 'procesador, cpu, gpu, tarjeta gráfica, ram, placa base, componentes, hardware'],
  ['🎮', 'Gaming', 'gaming, videojuego, videojuegos, consola, mando, playstation, xbox, nintendo, gamer, juegos'],
  ['🕹️', 'Mandos y joysticks', 'joystick, mando, controlador, arcade, retro, juegos'],
  ['🤖', 'Robots', 'robot, robots, aspirador robot, automatización, inteligencia artificial, ia'],
  ['🛰️', 'Drones y satélite', 'drone, dron, drones, gps, satélite, satelite, navegación'],
  ['📡', 'Antenas', 'antena, señal, radio, transmisión, wifi, receptor'],
  ['🔦', 'Linternas', 'linterna, linternas, frontal, luz, led, camping'],
  // Audio y vídeo
  ['🎧', 'Auriculares', 'auriculares, cascos, headphones, earbuds, tws, bluetooth, audio, sonido, headset'],
  ['🔊', 'Altavoces', 'altavoz, altavoces, speaker, barra de sonido, soundbar, sonido, audio, bafle, subwoofer'],
  ['🎤', 'Micrófonos', 'microfono, micrófono, podcast, grabación, grabacion, streaming, karaoke'],
  ['🎵', 'Música', 'música, musica, canciones, instrumentos, audio, melodía'],
  ['🎸', 'Instrumentos', 'guitarra, instrumento, instrumentos, bajo, ukelele, música, musica'],
  ['🎹', 'Teclados musicales', 'piano, teclado musical, sintetizador, órgano, organo, música'],
  ['📺', 'Televisores', 'televisor, televisión, television, tv, smart tv, pantalla, oled, qled, proyector'],
  ['📽️', 'Proyectores', 'proyector, cine en casa, home cinema, pantalla de proyección, vídeo'],
  ['📻', 'Radios', 'radio, dab, transistor, emisora, retro'],
  // Móviles y wearables
  ['📱', 'Móviles', 'movil, móvil, smartphone, iphone, android, teléfono, telefono, celular, funda, accesorios móviles'],
  ['⌚', 'Relojes inteligentes', 'smartwatch, reloj inteligente, reloj, pulsera, wearable, fitness, apple watch, amazfit'],
  ['🪫', 'Cargadores', 'cargador, cargadores, carga rápida, inalámbrico, inalambrico, magsafe, powerbank'],
  ['📲', 'Tablets', 'tablet, ipad, tableta, e-reader, ereader, kindle, lectura digital'],
  // Fotografía
  ['📷', 'Cámaras', 'camara, cámara, fotografía, fotografia, reflex, mirrorless, objetivo, foto, instantánea'],
  ['🎥', 'Cámaras de vídeo', 'videocámara, videocamara, cámara de acción, gopro, vídeo, video, grabación, filmación'],
  ['📹', 'Cámaras de seguridad', 'cámara de vigilancia, camara vigilancia, videovigilancia, seguridad, ip, timbre'],
  ['🎞️', 'Cine y película', 'cine, película, pelicula, películas, peliculas, film, fotograma'],
  ['🔭', 'Óptica', 'telescopio, prismáticos, prismaticos, óptica, optica, lente, astronomía, astronomia'],
  ['🔬', 'Microscopios', 'microscopio, laboratorio, ciencia, científico, cientifico'],
  // Hogar
  ['🏠', 'Hogar', 'hogar, casa, vivienda, decoración, decoracion, interior, domótica, domotica'],
  ['🛋️', 'Sofás y muebles', 'sofá, sofa, mueble, muebles, salón, salon, sillón, sillon, decoración'],
  ['🛏️', 'Dormitorio', 'cama, colchón, colchon, dormitorio, almohada, sábanas, sabanas, descanso'],
  ['🪑', 'Sillas', 'silla, sillas, silla gaming, silla de oficina, taburete, asiento'],
  ['🚪', 'Puertas', 'puerta, cerradura, cerraduras, cerrojo, entrada, timbre, portero'],
  ['💡', 'Iluminación', 'bombilla, bombillas, lámpara, lampara, iluminación, iluminacion, led, luz, foco, quinqué'],
  ['🕯️', 'Velas', 'vela, velas, ambiente, aroma, aromaterapia, decoración'],
  ['🧹', 'Limpieza', 'limpieza, escoba, fregona, aspirador, aspiradora, mopa, robot aspirador, hogar'],
  ['🧺', 'Colada', 'colada, lavandería, lavanderia, cesta, ropa, lavadora, plancha, secadora'],
  ['🧼', 'Higiene', 'jabón, jabon, higiene, limpieza, desinfectante, gel, dispensador'],
  ['🛁', 'Baño', 'baño, bano, bañera, bañera, ducha, grifería, griferia, toallas'],
  ['🚿', 'Ducha', 'ducha, grifo, alcachofa, mampara, baño, agua'],
  ['🪞', 'Espejos', 'espejo, espejos, tocador, maquillaje, baño'],
  ['🔥', 'Calefacción', 'calefacción, calefaccion, estufa, radiador, chimenea, calor, calefactor'],
  ['❄️', 'Climatización', 'aire acondicionado, ventilador, climatización, climatizacion, frío, frio, refrigeración, humidificador'],
  ['🌡️', 'Termómetros', 'termómetro, termometro, temperatura, termostato, medición, clima'],
  ['⏰', 'Despertadores', 'despertador, reloj, alarma, hora, reloj de pared'],
  ['🗝️', 'Llaves', 'llave, llaves, cerradura, seguridad, candado'],
  ['🔒', 'Seguridad', 'seguridad, candado, alarma, caja fuerte, protección, proteccion, antirrobo'],
  // Cocina
  ['🍳', 'Cocina', 'cocina, sartén, sarten, cacerola, olla, utensilios, menaje, freidora, batería de cocina'],
  ['☕', 'Café', 'cafe, café, cafetera, espresso, cápsulas, capsulas, taza, hervidor, té, te, infusión'],
  ['🍵', 'Té e infusiones', 'té, te, infusión, infusion, tetera, hervidor, matcha, taza'],
  ['🥤', 'Bebidas', 'bebida, bebidas, batido, zumo, exprimidor, licuadora, botella, vaso'],
  ['🍷', 'Vinos', 'vino, vinos, copa, copas, bodega, descorchador, decantador, sumiller'],
  ['🍺', 'Cerveza', 'cerveza, cervezas, bar, jarra, tirador, sifón, sifon'],
  ['🍽️', 'Vajilla', 'vajilla, plato, platos, cubiertos, mesa, menaje, cuberteria, cubertería'],
  ['🔪', 'Cuchillos', 'cuchillo, cuchillos, cuchillería, cuchilleria, afilador, tabla de cortar, chef'],
  ['🥘', 'Ollas', 'olla, olla a presión, olla a presion, robot de cocina, cocción, coccion, cazuela'],
  ['🍞', 'Panadería', 'pan, panadería, panaderia, tostadora, panificadora, horno, repostería, reposteria'],
  ['🥗', 'Comida saludable', 'ensalada, saludable, dieta, nutrición, nutricion, comida, vegetal'],
  ['🍕', 'Comida', 'comida, pizza, horno, alimentación, alimentacion, gourmet, delicatessen'],
  ['🧊', 'Frigoríficos', 'frigorífico, frigorifico, nevera, congelador, hielo, refrigeración, refrigeracion'],
  ['🥄', 'Utensilios', 'utensilios, cuchara, espátula, espatula, batidora, accesorios de cocina'],
  // Electrodomésticos
  ['🔧', 'Herramientas', 'herramienta, herramientas, bricolaje, llave inglesa, taller, reparación, reparacion'],
  ['🛠️', 'Bricolaje', 'bricolaje, taller, herramientas, reparar, manitas, mantenimiento, atornillador'],
  ['🔨', 'Martillos', 'martillo, mazo, percutor, construcción, construccion, obra, clavos'],
  ['🪚', 'Sierras', 'sierra, sierras, serrucho, madera, carpintería, carpinteria, corte'],
  ['🪛', 'Destornilladores', 'destornillador, atornillador, tornillo, tornillos, taladro, puntas'],
  ['⚙️', 'Mecánica', 'engranaje, mecánica, mecanica, piezas, recambios, ajustes, configuración'],
  ['🧰', 'Cajas de herramientas', 'caja de herramientas, maletín, maletin, kit, organizador, taller'],
  ['🪜', 'Escaleras', 'escalera, escaleras, taburete, altura, bricolaje'],
  ['🧯', 'Extintores', 'extintor, extintores, incendio, seguridad, fuego, protección contra incendios'],
  ['🔩', 'Tornillería', 'tornillo, tuerca, perno, ferretería, ferreteria, fijaciones, arandela'],
  // Jardín y exterior
  ['🌱', 'Jardín', 'jardín, jardin, plantas, semillas, huerto, cultivo, macetas, riego, jardinería'],
  ['🌳', 'Exterior', 'exterior, árbol, arbol, parque, naturaleza, aire libre, jardín'],
  ['🌻', 'Flores', 'flor, flores, ramo, floristería, floristeria, decoración floral, plantas'],
  ['🌧️', 'Riego', 'riego, manguera, aspersor, agua, lluvia, regadera, goteo'],
  ['🏕️', 'Camping', 'camping, tienda de campaña, acampada, senderismo, naturaleza, outdoor, mochila'],
  ['⛺', 'Tiendas de campaña', 'tienda de campaña, camping, acampada, saco de dormir, outdoor'],
  ['🔥', 'Barbacoa', 'barbacoa, parrilla, brasas, carbón, carbon, asador, grill'],
  ['🏊', 'Piscina', 'piscina, natación, natacion, baño, bano, flotador, verano, depuradora'],
  // Coche y movilidad
  ['🚗', 'Coche', 'coche, automóvil, automovil, auto, accesorios coche, motor, vehículo, vehiculo'],
  ['🏍️', 'Moto', 'moto, motocicleta, casco moto, scooter, motorista, accesorios moto'],
  ['🚲', 'Bicicletas', 'bicicleta, bici, ciclismo, mtb, casco, e-bike, bicicleta eléctrica, bicicleta electrica'],
  ['🛴', 'Patinetes', 'patinete, patinete eléctrico, patinete electrico, scooter, movilidad, urbana, monopatín'],
  ['⛽', 'Combustible', 'gasolina, combustible, repostaje, gasolinera, depósito, deposito, motor'],
  ['🛞', 'Neumáticos', 'neumático, neumatico, rueda, ruedas, llanta, cubierta, coche'],
  ['🚙', 'Todoterreno', 'todoterreno, 4x4, suv, off-road, baca, remolque'],
  ['🅿️', 'Aparcamiento', 'aparcamiento, parking, sensor de aparcamiento, garaje, cámara trasera'],
  ['✈️', 'Viajes', 'viaje, viajes, avión, avion, maleta, equipaje, vuelo, vacaciones, turismo'],
  ['🧳', 'Maletas', 'maleta, maletas, equipaje, viaje, trolley, mochila de viaje, candado'],
  ['🗺️', 'Mapas y navegación', 'mapa, mapas, navegación, navegacion, gps, brújula, brujula, ruta'],
  // Deporte y salud
  ['🏋️', 'Fitness', 'fitness, gimnasio, pesas, mancuernas, musculación, musculacion, entrenamiento, crossfit'],
  ['🏃', 'Running', 'running, correr, zapatillas, atletismo, carrera, trail, deporte'],
  ['⚽', 'Fútbol', 'fútbol, futbol, balón, balon, equipación, equipacion, portería, porteria'],
  ['🎾', 'Raquetas', 'tenis, pádel, padel, raqueta, pelota, bádminton, badminton'],
  ['🏀', 'Baloncesto', 'baloncesto, básquet, basquet, canasta, balón, nba'],
  ['🧘', 'Yoga', 'yoga, pilates, meditación, meditacion, esterilla, relajación, relajacion, bienestar'],
  ['🥾', 'Senderismo', 'senderismo, botas, montaña, montana, trekking, excursión, excursion, bastones'],
  ['⛷️', 'Esquí', 'esquí, esqui, nieve, snowboard, invierno, montaña, forfait'],
  ['🎣', 'Pesca', 'pesca, caña, cana, anzuelo, señuelo, senuelo, carrete, pescar'],
  ['🥊', 'Boxeo', 'boxeo, guantes, artes marciales, mma, combate, saco de boxeo'],
  ['💊', 'Salud', 'salud, medicina, vitaminas, suplementos, farmacia, botiquín, botiquin'],
  ['🩺', 'Médico', 'médico, medico, tensiómetro, tensiometro, salud, diagnóstico, estetoscopio, clínica'],
  ['🦷', 'Dental', 'dental, dientes, cepillo eléctrico, cepillo electrico, higiene bucal, ortodoncia, irrigador'],
  ['🩹', 'Primeros auxilios', 'botiquín, botiquin, tiritas, primeros auxilios, vendas, cura'],
  ['😴', 'Descanso', 'sueño, sueno, dormir, descanso, almohada, antifaz, ronquidos'],
  // Moda y belleza
  ['👕', 'Ropa', 'ropa, camiseta, moda, vestir, prendas, textil, camisa'],
  ['👗', 'Vestidos', 'vestido, falda, moda mujer, ropa de mujer, fiesta, conjunto'],
  ['👟', 'Zapatillas', 'zapatillas, calzado, sneakers, zapatos, deportivas, botas'],
  ['👜', 'Bolsos', 'bolso, bolsos, cartera, mochila, accesorios, bandolera, riñonera'],
  ['🎒', 'Mochilas', 'mochila, mochilas, escolar, portátil mochila, senderismo, bolsa'],
  ['🕶️', 'Gafas de sol', 'gafas, gafas de sol, lentes, sol, polarizadas, accesorios'],
  ['💍', 'Joyería', 'joya, joyas, joyería, joyeria, anillo, collar, pulsera, bisutería, bisuteria'],
  ['💄', 'Maquillaje', 'maquillaje, belleza, labial, cosmética, cosmetica, cosméticos, cosmeticos, make up'],
  ['💇', 'Peluquería', 'peluquería, peluqueria, secador, plancha de pelo, cabello, pelo, rizador, cortapelos'],
  ['🧴', 'Cuidado de la piel', 'crema, piel, cuidado, cosmética, hidratante, protector solar, loción, locion'],
  ['🪒', 'Afeitado', 'afeitadora, afeitado, barba, maquinilla, cortapelos, recortadora, cuchilla'],
  ['🧢', 'Gorras', 'gorra, gorras, sombrero, gorro, accesorios, moda'],
  // Familia, mascotas, ocio
  ['🐶', 'Perros', 'perro, perros, mascota, mascotas, correa, collar, comida para perros, juguete'],
  ['🐱', 'Gatos', 'gato, gatos, mascota, mascotas, arenero, rascador, comida para gatos'],
  ['🐟', 'Acuarios', 'pez, peces, acuario, pecera, filtro, mascota, agua'],
  ['🍼', 'Bebés', 'bebé, bebe, biberón, biberon, cuna, carrito, pañal, puericultura, maternidad'],
  ['🧸', 'Juguetes', 'juguete, juguetes, peluche, niños, ninos, infantil, muñeco, juegos'],
  ['🧩', 'Puzles y juegos de mesa', 'puzle, puzzle, juego de mesa, juegos de mesa, rompecabezas, ingenio, tablero'],
  ['🎲', 'Juegos de mesa', 'dados, juego de mesa, azar, tablero, cartas, rol, familia'],
  ['🎨', 'Arte y manualidades', 'arte, pintura, manualidades, dibujo, pinceles, lienzo, colores, creatividad'],
  ['✏️', 'Papelería', 'papelería, papeleria, lápiz, lapiz, boli, bolígrafo, boligrafo, escritura, cuaderno'],
  ['📚', 'Libros', 'libro, libros, lectura, novela, biblioteca, ebook, literatura, cuentos'],
  ['🎓', 'Educación', 'educación, educacion, estudios, universidad, formación, formacion, cursos, escolar'],
  ['🎁', 'Regalos', 'regalo, regalos, cumpleaños, detalle, sorpresa, packs, navidad'],
  ['🎄', 'Navidad', 'navidad, árbol de navidad, adornos, decoración navideña, luces, belén'],
  ['🎉', 'Fiestas', 'fiesta, fiestas, celebración, celebracion, cumpleaños, globos, decoración de fiesta'],
  ['🧵', 'Costura', 'costura, hilo, aguja, máquina de coser, maquina de coser, tela, patchwork'],
  // Oficina y negocio
  ['🏢', 'Oficina', 'oficina, trabajo, negocio, empresa, escritorio, mobiliario de oficina, coworking'],
  ['📎', 'Material de oficina', 'clips, grapadora, archivador, carpeta, material de oficina, papelería'],
  ['📦', 'Envíos y embalaje', 'caja, cajas, paquete, embalaje, envío, envio, almacén, almacen, logística'],
  ['💼', 'Maletines', 'maletín, maletin, cartera, negocios, ejecutivo, portadocumentos'],
  ['📊', 'Estadísticas', 'gráfico, grafico, estadísticas, estadisticas, datos, análisis, analisis, métricas'],
  ['💰', 'Finanzas', 'dinero, ahorro, finanzas, oferta, ofertas, precio, descuento, inversión'],
  ['🏷️', 'Ofertas', 'oferta, ofertas, descuento, etiqueta, rebajas, promoción, promocion, chollo'],
  ['🛒', 'Compras', 'compra, compras, carrito, tienda, supermercado, comercio, cesta'],
  // Energía y medio ambiente
  ['☀️', 'Energía solar', 'solar, placa solar, panel solar, energía, energia, fotovoltaica, sol, autoconsumo'],
  ['⚡', 'Electricidad', 'electricidad, energía, energia, eléctrico, electrico, corriente, voltios, potencia'],
  ['♻️', 'Reciclaje', 'reciclaje, ecológico, ecologico, sostenible, reutilizable, medio ambiente, eco'],
  ['💧', 'Agua', 'agua, filtro de agua, depuración, depuracion, grifo, botella, hidratación'],
  ['🌬️', 'Aire', 'aire, purificador, ventilación, ventilacion, humidificador, deshumidificador, ventilador'],
  // Misc
  ['⭐', 'Destacados', 'destacado, favorito, mejor valorado, estrella, recomendado, top, premium'],
  ['🆕', 'Novedades', 'novedad, novedades, nuevo, lanzamiento, última generación, ultima generacion'],
  ['🔥', 'Tendencias', 'tendencia, tendencias, popular, viral, más vendido, mas vendido, éxito, exito'],
  ['🧪', 'Laboratorio', 'laboratorio, química, quimica, experimentos, ciencia, probeta'],
  ['🕰️', 'Relojes', 'reloj, relojes, reloj de pulsera, reloj de pared, cronógrafo, cronografo, hora'],
  ['🖼️', 'Marcos y cuadros', 'cuadro, cuadros, marco, marcos, póster, poster, decoración de pared, lámina'],
  ['🎬', 'Cine', 'cine, película, pelicula, claqueta, vídeo, video, rodaje, streaming'],
  ['🔔', 'Timbres y alertas', 'timbre, alarma, aviso, notificación, notificacion, campana, alertas'],
  ['🗑️', 'Basura', 'basura, papelera, cubo, contenedor, reciclaje, residuos'],
];

const FOLD_RE = /[̀-ͯ]/g;
export const foldWord = (value: unknown): string =>
  String(value ?? '').normalize('NFD').replace(FOLD_RE, '').toLowerCase().trim();

export const ICON_LIBRARY: IconEntry[] = RAW.map(([emoji, label, words]) => ({
  emoji,
  label,
  words: words.split(',').map((w) => w.trim()).filter(Boolean),
}));

const stem = (word: string): string => {
  const w = foldWord(word);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s')) return w.slice(0, -1);
  return w;
};

/** ¿La cadena contiene letras? (una entrada sólo con emojis no es una «palabra» a buscar). */
export const hasLetters = (value: string): boolean => /[\p{L}\p{N}]/u.test(value);

/** Emojis relacionados con la palabra escrita, por relevancia. Sin letras → []. */
export function searchIcons(query: string, limit = 24): IconEntry[] {
  const q = foldWord(query);
  if (!q || !hasLetters(q)) return [];
  const tokens = q.split(/\s+/).filter((t) => t.length >= 2).map(stem);
  if (!tokens.length) return [];
  const scored: Array<{ entry: IconEntry; score: number }> = [];
  const seen = new Set<string>();
  for (const entry of ICON_LIBRARY) {
    const labelF = foldWord(entry.label);
    const words = entry.words.map(foldWord);
    let score = 0;
    for (const token of tokens) {
      if (labelF === token || stem(labelF) === token) score += 8;
      else if (labelF.startsWith(token)) score += 5;
      else if (labelF.includes(token)) score += 3;
      for (const w of words) {
        if (w === token || stem(w) === token) score += 6;
        else if (w.startsWith(token) || token.startsWith(stem(w)) && stem(w).length >= 4) score += 3;
        else if (w.includes(token) && token.length >= 4) score += 2;
      }
    }
    if (score > 0 && !seen.has(entry.emoji + entry.label)) {
      seen.add(entry.emoji + entry.label);
      scored.push({ entry, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label, 'es'));
  // Un mismo emoji (p. ej. 🔥) sólo se propone una vez.
  const out: IconEntry[] = [];
  const used = new Set<string>();
  for (const { entry } of scored) {
    if (used.has(entry.emoji)) continue;
    used.add(entry.emoji);
    out.push(entry);
    if (out.length >= limit) break;
  }
  // Pocos resultados directos: se amplían con iconos RELACIONADOS (comparten términos con los mejores resultados).
  if (out.length > 0 && out.length < 8) {
    const topWords = new Set(out.slice(0, 2).flatMap((e) => e.words.map(foldWord)).filter((w) => w.length >= 4));
    const extra: Array<{ entry: IconEntry; shared: number }> = [];
    for (const entry of ICON_LIBRARY) {
      if (used.has(entry.emoji)) continue;
      const shared = entry.words.map(foldWord).filter((w) => topWords.has(w)).length;
      if (shared > 0) extra.push({ entry, shared });
    }
    extra.sort((a, b) => b.shared - a.shared || a.entry.label.localeCompare(b.entry.label, 'es'));
    for (const { entry } of extra) {
      if (used.has(entry.emoji)) continue;
      used.add(entry.emoji);
      out.push(entry);
      if (out.length >= 10) break;
    }
  }
  return out;
}

/**
 * Palabras clave para una categoría a partir de la palabra definida: la propia palabra (con y sin tilde, singular y plural)
 * más los términos relacionados de los iconos que coinciden (o del icono elegido). Minúsculas, sin duplicados, máx. 14.
 */
export function suggestKeywords(word: string, chosenEmoji?: string, max = 14): string[] {
  const clean = String(word ?? '').trim().toLowerCase();
  if (!clean || !hasLetters(clean)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const w = raw.trim().toLowerCase();
    if (w.length < 3 || !hasLetters(w)) return;
    const key = foldWord(w);
    // Conserva la variante con tilde y añade la plana si difiere (como las palabras clave ya existentes).
    for (const variant of key !== w ? [w, key] : [w]) {
      if (!seen.has(variant)) {
        seen.add(variant);
        out.push(variant);
      }
    }
  };
  push(clean);
  const folded = foldWord(clean);
  if (!folded.includes(' ')) {
    const singular = stem(folded);
    if (singular !== folded) push(singular);
    else if (!folded.endsWith('s')) push(folded.endsWith('z') ? folded.slice(0, -1) + 'ces' : folded + 's');
  }
  const related = chosenEmoji ? ICON_LIBRARY.filter((e) => e.emoji === chosenEmoji) : searchIcons(clean, 3).slice(0, 2);
  for (const entry of related) for (const w of entry.words) push(w);
  return out.slice(0, max);
}
