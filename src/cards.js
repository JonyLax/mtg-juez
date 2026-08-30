// Nombres de carta en otros idiomas.
//
// Scryfall no sabe buscar por nombre traducido: su operador `name:` compara
// siempre contra el nombre inglés, y `lang:` solo decide en qué idioma te
// devuelve la carta. Por eso llevamos nuestro propio diccionario en D1, que
// construye tools/build_cards.py.
//
// Con él resolvemos dos cosas: traducir "Sra. Margarita" a "Ms. Bumbleflower"
// antes de preguntarle a Scryfall, y autocompletar mientras se escribe.

const HEADERS = {
  "User-Agent": "mtg-juez/1.0 (bot privado de reglas para un grupo de amigos)",
  Accept: "application/json",
};

/** Traduce un nombre impreso a su nombre inglés. Devuelve null si no lo conoce. */
export async function aIngles(env, nombre) {
  if (!env.DB || !nombre) return null;
  const lc = nombre.trim().toLowerCase();
  try {
    const fila = await env.DB.prepare(
      "SELECT english FROM card_names WHERE printed_lc = ? LIMIT 1"
    ).bind(lc).first();
    return fila?.english || null;
  } catch {
    return null; // sin índice cargado seguimos como antes
  }
}

/**
 * Sugerencias para el autocompletado. Mezcla nuestro índice (cualquier idioma)
 * con el endpoint de Scryfall (solo inglés), sin repetir cartas.
 */
export async function sugerir(env, consulta, limite = 8) {
  const q = String(consulta || "").trim();
  if (q.length < 2) return [];
  const lc = q.toLowerCase();
  const vistas = new Set();
  const salida = [];

  // 1. Nuestro índice. Primero lo que empieza por lo escrito, que es lo que
  //    espera quien teclea; después lo que lo contiene en medio.
  if (env.DB) {
    try {
      const { results } = await env.DB.prepare(
        "SELECT printed, english, lang FROM card_names " +
        "WHERE printed_lc LIKE ?1 OR printed_lc LIKE ?2 " +
        "ORDER BY CASE WHEN printed_lc LIKE ?1 THEN 0 ELSE 1 END, length(printed) " +
        "LIMIT ?3"
      ).bind(`${lc}%`, `%${lc}%`, limite).all();
      for (const r of results || []) {
        if (vistas.has(r.english)) continue;
        vistas.add(r.english);
        salida.push({ nombre: r.printed, ingles: r.english, lang: r.lang });
      }
    } catch { /* sin índice, seguimos */ }
  }

  // 2. Scryfall para los nombres en inglés
  if (salida.length < limite) {
    try {
      const res = await fetch(
        `https://api.scryfall.com/cards/autocomplete?q=${encodeURIComponent(q)}`,
        { headers: HEADERS, cf: { cacheTtl: 3600, cacheEverything: true },
          signal: AbortSignal.timeout(5000) }
      );
      if (res.ok) {
        const d = await res.json();
        for (const nombre of d.data || []) {
          if (salida.length >= limite || vistas.has(nombre)) continue;
          vistas.add(nombre);
          salida.push({ nombre, ingles: nombre, lang: "en" });
        }
      }
    } catch { /* el índice propio ya habrá dado algo */ }
  }

  return salida.slice(0, limite);
}
