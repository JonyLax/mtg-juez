import cr from "../data/cr.json";
import { ES_EN, SLANG, STOPWORDS } from "./glossary.js";

// IMPORTANTE: el indice se construye aqui, en el ambito del modulo, no dentro
// del handler. El plan gratuito de Workers da 10 ms de CPU por peticion, y
// construir el indice cuesta unos 80 ms: si se hiciera de forma perezosa, la
// primera peticion de cada isolate moriria con error 1102. En el ambito del
// modulo cuenta contra el limite de arranque (400 ms), que si da de sobra.
let INDEX = null;

const K1 = 1.4;
const B = 0.72;

// Secciones que se inyectan siempre segun el formato, porque cambian reglas de
// verdad y el jugador no siempre sabe que tiene que preguntar por ellas.
const FORMAT_SECTIONS = {
  commander: ["903"],
  "2hg": ["810"],
  casual: ["806"],
  limited: ["100"],
  duel: [],
};

const NON_ASCII = /[^\x00-\x7F]/;

export function normalize(s) {
  // Las reglas son ASCII puro; solo las preguntas traen tildes. Saltarse la
  // normalizacion Unicode cuando no hace falta recorta a la mitad el arranque.
  if (!NON_ASCII.test(s)) return s.toLowerCase();
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function tokenize(s) {
  const out = [];
  for (const t of normalize(s).match(/[a-z0-9]+/g) || []) {
    if (t.length < 2 || STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

/** Traduce terminologia castellana a la del documento antes de buscar. */
export function expandQuery(query) {
  const flat = normalize(query).replace(/\s+/g, " ");
  const extra = [];

  const phrases = Object.keys(ES_EN).sort((a, b) => b.length - a.length);
  for (const es of phrases) {
    if (flat.includes(es)) extra.push(ES_EN[es]);
  }
  for (const word of flat.match(/[a-z0-9]+/g) || []) {
    if (SLANG[word]) extra.push(SLANG[word]);
  }
  return query + " " + extra.join(" ");
}

function docText(d) {
  return d.kind === "glossary"
    ? `${d.term} ${d.text}`
    : `${d.section_title} ${d.text}`;
}

function buildIndex() {
  const docs = [];
  for (const r of cr.rules) docs.push({ ...r, kind: "rule" });
  for (const g of cr.glossary)
    docs.push({ id: `G:${g.term}`, kind: "glossary", term: g.term, text: g.text });

  const postings = new Map(); // token -> [[docIdx, tf], ...]
  const lengths = new Float32Array(docs.length);
  let total = 0;

  docs.forEach((d, i) => {
    const toks = tokenize(docText(d));
    lengths[i] = toks.length;
    total += toks.length;
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, n] of tf) {
      let p = postings.get(t);
      if (!p) postings.set(t, (p = []));
      p.push([i, n]);
    }
  });

  const idf = new Map();
  const N = docs.length;
  for (const [t, p] of postings) {
    idf.set(t, Math.log(1 + (N - p.length + 0.5) / (p.length + 0.5)));
  }

  const byId = new Map();
  docs.forEach((d, i) => byId.set(d.id, i));

  return { docs, postings, idf, lengths, avgdl: total / N, byId };
}

export function getIndex() {
  return INDEX;
}

function bm25(queryTokens, topN) {
  const ix = INDEX;
  const scores = new Map();

  for (const t of queryTokens) {
    const p = ix.postings.get(t);
    if (!p) continue;
    const w = ix.idf.get(t);
    for (const [i, tf] of p) {
      const dl = ix.lengths[i];
      const s = w * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * dl) / ix.avgdl)));
      scores.set(i, (scores.get(i) || 0) + s);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([i, score]) => ({ doc: ix.docs[i], score }));
}

/**
 * Devuelve las reglas relevantes para una pregunta.
 * Combina tres cosas: aciertos de BM25, sus reglas padre y las reglas
 * referenciadas explicitamente ("see rule 603.3"), mas las secciones que el
 * formato obliga a tener siempre delante.
 */
export function retrieve(question, format, { maxRules = 26, maxGlossary = 5 } = {}) {
  const ix = getIndex();
  const tokens = tokenize(expandQuery(question));
  const hits = bm25(tokens, 120);

  const chosen = new Map(); // id -> doc
  const add = (doc) => {
    if (doc && !chosen.has(doc.id)) chosen.set(doc.id, doc);
  };
  const byId = (id) => {
    const i = ix.byId.get(id);
    return i === undefined ? null : ix.docs[i];
  };

  // 1. Orientacion del formato: solo las reglas de primer nivel de la seccion
  //    (903.1, 903.2...), no las subreglas. Dan el marco sin comerse el
  //    presupuesto, y BM25 ya traera las subreglas concretas si hacen falta.
  for (const sec of FORMAT_SECTIONS[format] || []) {
    for (const d of ix.docs) {
      if (d.kind === "rule" && d.section === sec && !d.parent) add(d);
    }
  }
  const forcedCount = chosen.size;

  // 2. Aciertos de busqueda, cada uno con su regla padre para que no quede
  //    una subregla huerfana sin contexto.
  const ruleHits = hits.filter((h) => h.doc.kind === "rule");
  for (const h of ruleHits) {
    if (chosen.size - forcedCount >= maxRules) break;
    if (h.doc.parent) add(byId(h.doc.parent));
    add(h.doc);
  }

  // 3. Referencias cruzadas explicitas de los mejores aciertos
  const refs = new Set();
  for (const h of ruleHits.slice(0, 8)) {
    for (const m of (h.doc.text || "").matchAll(/rule (\d{3}\.\d+[a-z]?)/g)) {
      refs.add(m[1]);
    }
  }
  let budget = 8;
  for (const id of refs) {
    if (budget-- <= 0) break;
    add(byId(id));
  }

  // 4. Glosario, puntuado aparte para que las reglas no lo desplacen siempre
  const glossary = hits
    .filter((h) => h.doc.kind === "glossary")
    .slice(0, maxGlossary)
    .map((h) => h.doc);

  const rules = [...chosen.values()]
    .slice(0, 70) // tope duro: mas de esto no mejora la respuesta y gasta cuota
    .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));

  return { rules, glossary, meta: cr.meta };
}

export function rulesMeta() {
  return cr.meta;
}

// Se ejecuta al arrancar el isolate, una sola vez.
INDEX = buildIndex();
