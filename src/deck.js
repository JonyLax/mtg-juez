// Construcción de mazos: de dónde salen las cartas.
//
// Regla de oro de este fichero: el modelo NO nombra cartas. El modelo propone
// búsquedas, y aquí se ejecutan contra Scryfall. Todo lo que acabe en una
// recomendación existe, está en la identidad de color correcta, es legal en el
// formato y cuesta lo que decimos que cuesta. El criterio de sinergia lo pone
// el modelo; los hechos los ponemos nosotros.

const HEADERS = {
  "User-Agent": "mtg-juez/1.0 (bot privado de reglas para un grupo de amigos)",
  Accept: "application/json",
};
const SCRY = "https://api.scryfall.com";
const SPELLBOOK = "https://backend.commanderspellbook.com";

// Cuántos "game changers" admite cada bracket, según la lista oficial de Wizards.
// Los brackets son una herramienta de conversación, no una norma que se aplique
// sola, pero contarlos es la lectura más rápida del nivel de un mazo.
export const BRACKETS = {
  1: { nombre: "Exhibition", gamechangers: 0, nota: "Mazo temático, sin intención de ganar rápido." },
  2: { nombre: "Core", gamechangers: 0, nota: "Nivel de mazo precon. Partidas largas." },
  3: { nombre: "Upgraded", gamechangers: 3, nota: "Precon mejorado. Hasta tres game changers." },
  4: { nombre: "Optimized", gamechangers: Infinity, nota: "Sin restricciones, pero no competitivo puro." },
  5: { nombre: "cEDH", gamechangers: Infinity, nota: "Competitivo. Ganar es lo único que importa." },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scryfall(ruta, { cache = 3600 } = {}) {
  const res = await fetch(`${SCRY}${ruta}`, {
    headers: HEADERS,
    cf: { cacheTtl: cache, cacheEverything: true },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) return null;
  return res.json();
}

/** Lo que nos interesa de una carta, y nada más: el contexto es caro. */
function resumir(c, moneda = "eur") {
  const cara = c.card_faces?.[0] || c;
  return {
    nombre: c.name,
    coste: cara.mana_cost || "",
    vm: c.mana_value ?? c.cmc ?? 0,
    tipo: cara.type_line || c.type_line || "",
    texto: (c.card_faces
      ? c.card_faces.map((f) => f.oracle_text).filter(Boolean).join(" // ")
      : c.oracle_text) || "",
    identidad: (c.color_identity || []).join("") || "incolora",
    precio: c.prices?.[moneda] ? Number(c.prices[moneda]) : null,
    gamechanger: !!c.game_changer,
    rank: c.edhrec_rank ?? null,
    uri: c.scryfall_uri,
  };
}

/**
 * Ejecuta una búsqueda de Scryfall aplicando siempre los límites del mazo.
 *
 * Los filtros duros (identidad de color, legalidad, presupuesto) se añaden
 * aquí y no se dejan en manos del modelo: si se le olvidara uno, el mazo
 * saldría mal y el usuario no tendría forma de saberlo.
 */
export async function buscarCartas(consulta, limites = {}, maximo = 12) {
  const {
    identidad, formato = "commander", presupuestoCarta, sinGamechangers,
    // El publico es sobre todo espanol: los precios en euros son los utiles.
    moneda = "eur",
  } = limites;
  const partes = [consulta.trim()];

  if (formato) partes.push(`legal:${formato}`);
  // "commander:wubrg" en Scryfall significa identidad de color <= esa
  if (identidad) partes.push(`commander:${identidad.toLowerCase() || "c"}`);
  if (presupuestoCarta) partes.push(`${moneda}<=${presupuestoCarta}`);
  if (sinGamechangers) partes.push("-is:gamechanger");
  partes.push("game:paper");

  const q = partes.join(" ");
  // cheapest:<moneda> -> el precio devuelto es el de la impresión más barata,
  // que es la definición de presupuesto que pidió el usuario.
  const url = `/cards/search?q=${encodeURIComponent(`${q} cheapest:${moneda}`)}` +
              `&unique=cards&order=edhrec&dir=asc`;

  const datos = await scryfall(url);
  if (!datos?.data) return { consulta: q, total: 0, cartas: [] };

  return {
    consulta: q,
    total: datos.total_cards ?? datos.data.length,
    cartas: datos.data.slice(0, maximo).map((c) => resumir(c, moneda)),
  };
}

/** Ficha completa de una carta concreta, para anclar la conversación. */
export async function fichaCarta(nombre, moneda = "eur") {
  const c = await scryfall(`/cards/named?fuzzy=${encodeURIComponent(nombre)}`);
  if (!c) return null;
  return { ...resumir(c, moneda), identidad_lista: c.color_identity || [] };
}

/**
 * Combos verificados que incluyen una carta, según Commander Spellbook.
 * Esto es lo que convierte "¿qué va bien con Tiamat?" en una respuesta con
 * respaldo en vez de una intuición del modelo.
 */
export async function combosCon(nombres, identidad) {
  const lista = (Array.isArray(nombres) ? nombres : [nombres]).filter(Boolean);
  if (!lista.length) return [];

  try {
    const res = await fetch(`${SPELLBOOK}/find-my-combos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        commanders: identidad ? [] : [],
        main: lista.map((n) => ({ card: n, quantity: 1 })),
      }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const d = await res.json();

    // "almost included" son los combos a los que les falta 1-2 cartas: justo lo
    // que interesa para recomendar qué añadir.
    const casi = d.results?.almostIncluded || [];
    return casi.slice(0, 12).map((v) => ({
      cartas: (v.uses || []).map((u) => u.card?.name).filter(Boolean),
      faltan: (v.uses || [])
        .filter((u) => !lista.some((n) => n.toLowerCase() === (u.card?.name || "").toLowerCase()))
        .map((u) => u.card?.name)
        .filter(Boolean),
      produce: (v.produces || []).map((p) => p.feature?.name).filter(Boolean),
      identidad: (v.identity || "").toUpperCase(),
      enlace: v.id ? `https://commanderspellbook.com/combo/${v.id}/` : null,
    }));
  } catch {
    return []; // sin combos verificados seguimos: el modelo razonará sin ellos
  }
}

/**
 * Ejecuta el plan de búsquedas que ha propuesto el modelo. En serie y con
 * pausa, que Scryfall pide no pasar de 10 peticiones por segundo.
 */
export async function ejecutarPlan(plan, limites) {
  const resultados = [];
  const vistas = new Set();

  for (const paso of (plan.busquedas || []).slice(0, 8)) {
    const r = await buscarCartas(paso.consulta, limites, paso.cuantas || 10);
    // Sin repetir cartas entre búsquedas: gastan contexto y confunden al modelo
    r.cartas = r.cartas.filter((c) => !vistas.has(c.nombre));
    r.cartas.forEach((c) => vistas.add(c.nombre));
    resultados.push({ para: paso.para || "", ...r });
    await sleep(120);
  }
  return resultados;
}

/** Texto que se le pasa al modelo en la segunda vuelta. */
export function contextoDeCartas(resultados, combos, moneda = "eur") {
  const simbolo = moneda === "eur" ? "EUR" : "USD";
  const partes = [];

  if (combos?.length) {
    partes.push("=== COMBOS VERIFICADOS (Commander Spellbook) ===");
    partes.push("Combos reales a los que les falta alguna carta para completarse:");
    for (const c of combos) {
      partes.push(
        `- Con ${c.cartas.join(" + ")} → ${c.produce.join(", ") || "resultado no descrito"}` +
        (c.faltan.length ? `. Te faltan: ${c.faltan.join(", ")}` : "")
      );
    }
    partes.push("");
  }

  partes.push("=== CARTAS DISPONIBLES ===");
  partes.push(
    `Estas son las ÚNICAS cartas que puedes recomendar. El precio es el de la ` +
    `impresión más barata en ${simbolo}. No nombres NINGUNA carta que no esté en esta lista.`
  );
  for (const r of resultados) {
    if (!r.cartas.length) continue;
    partes.push(`\n--- ${r.para || r.consulta} (${r.total} resultados, muestro ${r.cartas.length})`);
    for (const c of r.cartas) {
      const precio = c.precio === null ? "sin precio" : `${c.precio.toFixed(2)} ${simbolo}`;
      partes.push(
        `${c.nombre} | ${c.coste} | ${c.tipo} | ${precio}` +
        (c.gamechanger ? " | GAME CHANGER" : "") +
        `\n    ${c.texto.replace(/\n/g, " ")}`
      );
    }
  }
  return partes.join("\n");
}

/** Comprueba el mazo propuesto contra los límites que pidió el jugador. */
export function revisarMazo(cartas, limites) {
  const avisos = [];
  const gc = cartas.filter((c) => c.gamechanger);
  const tope = BRACKETS[limites.bracket]?.gamechangers;

  if (tope !== undefined && gc.length > tope) {
    avisos.push(
      `El bracket ${limites.bracket} admite ${tope === Infinity ? "todos" : tope} game changers ` +
      `y aquí hay ${gc.length}: ${gc.map((c) => c.nombre).join(", ")}.`
    );
  }

  const total = cartas.reduce((s, c) => s + (c.precio || 0), 0);
  const sim = limites.moneda === "usd" ? "USD" : "EUR";
  if (limites.presupuesto && total > limites.presupuesto) {
    avisos.push(
      `La suma da ${total.toFixed(2)} ${sim} y el presupuesto era ${limites.presupuesto} ${sim}.`
    );
  }

  const sinPrecio = cartas.filter((c) => c.precio === null);
  if (sinPrecio.length) {
    avisos.push(`Sin precio en Scryfall: ${sinPrecio.map((c) => c.nombre).join(", ")}.`);
  }

  return { total, gamechangers: gc.length, avisos };
}
