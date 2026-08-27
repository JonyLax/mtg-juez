// Scryfall exige cabecera User-Agent descriptiva y Accept en cada peticion, y
// pide mantenerse por debajo de 10 req/s. Los User-Agent genericos los bloquean.
const HEADERS = {
  "User-Agent": "mtg-juez/1.0 (bot privado de reglas para un grupo de amigos)",
  Accept: "application/json",
};

// Cloudflare cachea la respuesta en el borde: las cartas no cambian a diario.
const CF = { cf: { cacheTtl: 43200, cacheEverything: true } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Saca los nombres escritos entre dobles corchetes: [[Lightning Bolt]] */
export function extractCardNames(text, max = 4) {
  const names = [];
  for (const m of text.matchAll(/\[\[([^\]\n]{2,80})\]\]/g)) {
    const n = m[1].trim();
    if (n && !names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n);
    if (names.length >= max) break;
  }
  return names;
}

async function get(url) {
  const res = await fetch(url, { headers: HEADERS, ...CF });
  if (!res.ok) return null;
  return res.json();
}

async function lookup(name) {
  // Primero por nombre en ingles con tolerancia a erratas
  const fuzzy = await get(
    `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`
  );
  if (fuzzy) return fuzzy;

  // Si no, busca el nombre impreso en castellano
  const q = `lang:es name:"${name.replace(/"/g, "")}"`;
  const search = await get(
    `https://api.scryfall.com/cards/search?unique=cards&q=${encodeURIComponent(q)}`
  );
  return search?.data?.[0] || null;
}

function faces(card) {
  if (!card.card_faces) return null;
  return card.card_faces.map((f) => ({
    name: f.name,
    mana_cost: f.mana_cost || "",
    type_line: f.type_line || "",
    oracle_text: f.oracle_text || "",
    power: f.power,
    toughness: f.toughness,
  }));
}

/**
 * Busca cada carta y sus rulings oficiales. Va en serie con pausa para
 * respetar el limite de Scryfall.
 */
export async function fetchCards(names, legalityKey) {
  const out = [];
  for (const name of names) {
    let card;
    try {
      card = await lookup(name);
    } catch {
      card = null;
    }
    if (!card) {
      out.push({ query: name, found: false });
      await sleep(120);
      continue;
    }

    let rulings = [];
    if (card.rulings_uri) {
      try {
        const r = await get(card.rulings_uri);
        rulings = (r?.data || [])
          .slice(-6)
          .map((x) => x.comment)
          .filter(Boolean);
      } catch {
        /* los rulings son opcionales */
      }
    }

    out.push({
      query: name,
      found: true,
      name: card.name,
      printed_name: card.printed_name || null,
      mana_cost: card.mana_cost || "",
      type_line: card.type_line || "",
      oracle_text: card.oracle_text || "",
      power: card.power,
      toughness: card.toughness,
      loyalty: card.loyalty,
      faces: faces(card),
      legality: legalityKey ? card.legalities?.[legalityKey] || "unknown" : null,
      scryfall_uri: card.scryfall_uri,
      image: card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || null,
      rulings,
    });

    await sleep(120);
  }
  return out;
}
