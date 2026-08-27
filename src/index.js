import { retrieve, rulesMeta } from "./retrieval.js";
import { extractCardNames, fetchCards } from "./scryfall.js";
import { FORMATS, systemPrompt, buildContext, RESPONSE_SCHEMA } from "./prompt.js";

// Alias que apunta siempre al Flash estable mas reciente. Si tu clave no tiene
// acceso, llama a GET /api/models y pon aqui uno de los ids que te devuelva.
const MODEL = "gemini-flash-latest";
const GEMINI = "https://generativelanguage.googleapis.com/v1beta";

const MAX_QUESTION = 2000;
const MAX_HISTORY = 8;

const LEGALITY_KEYS = new Set([
  "standard", "pioneer", "modern", "legacy", "vintage",
  "pauper", "commander", "brawl", "historic", "alchemy", "oathbreaker",
]);

function cors(env, extra = {}) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Club-Key",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
}

const json = (env, body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: cors(env, { "Content-Type": "application/json; charset=utf-8" }),
  });

function authorized(request, env) {
  if (!env.CLUB_KEY) return true; // sin secreto configurado, modo abierto
  if (request.headers.get("X-Club-Key") === env.CLUB_KEY) return true;
  // Las rutas de diagnostico se abren a mano en el navegador, que no puede
  // mandar cabeceras: para esas admitimos la clave como ?k=
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/diag") || url.pathname.startsWith("/api/models")) {
    return url.searchParams.get("k") === env.CLUB_KEY;
  }
  return false;
}

async function callGemini(env, { system, contents }) {
  if (!env.GEMINI_API_KEY) {
    const err = new Error("sin clave");
    err.detail =
      "No hay GEMINI_API_KEY configurada. Panel de Cloudflare > tu Worker > " +
      "Settings > Variables and Secrets > Add, tipo Secret.";
    throw err;
  }

  const res = await fetch(
    `${GEMINI}/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: {
          temperature: 0.15,
          // Los modelos actuales razonan antes de responder y ese razonamiento
          // consume presupuesto de salida. Con margen corto se quedan sin
          // tokens antes de escribir nada y devuelven una respuesta vacia.
          maxOutputTokens: 8192,
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    }
  );

  const raw = await res.text();

  if (!res.ok) {
    let msg = raw.slice(0, 400);
    try {
      msg = JSON.parse(raw)?.error?.message || msg;
    } catch {
      /* la respuesta no era JSON */
    }
    const err = new Error(`Gemini ${res.status}`);
    err.status = res.status;
    err.detail = `HTTP ${res.status} — ${msg}`;
    if (res.status === 404) {
      err.detail += ` (el modelo "${MODEL}" no existe o tu clave no tiene acceso; mira /api/models)`;
    }
    throw err;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    const err = new Error("respuesta ilegible");
    err.detail = `Gemini no ha devuelto JSON: ${raw.slice(0, 300)}`;
    throw err;
  }

  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");

  if (!text) {
    const reason = cand?.finishReason || data.promptFeedback?.blockReason || "desconocido";
    const u = data.usageMetadata || {};
    const err = new Error("respuesta vacia");
    err.detail =
      `El modelo no ha escrito nada. finishReason=${reason}. ` +
      `Tokens: entrada=${u.promptTokenCount ?? "?"}, salida=${u.candidatesTokenCount ?? "?"}` +
      (u.thoughtsTokenCount ? `, razonamiento=${u.thoughtsTokenCount}` : "") +
      (reason === "MAX_TOKENS"
        ? ". Sube maxOutputTokens en src/index.js."
        : reason === "SAFETY"
          ? ". Un filtro de contenido ha bloqueado la respuesta."
          : "");
    throw err;
  }

  try {
    return JSON.parse(text);
  } catch {
    const err = new Error("JSON invalido");
    err.detail = `El modelo no ha respetado el esquema: ${text.slice(0, 300)}`;
    throw err;
  }
}

async function ask(request, env) {
  const body = await request.json();
  const question = String(body.question || "").slice(0, MAX_QUESTION).trim();
  if (!question) return json(env, { error: "Falta la pregunta." }, 400);

  const format = FORMATS[body.format] ? body.format : "duel";
  const houseRules = String(body.houseRules || "").slice(0, 800).trim();

  let legalityKey = FORMATS[format].legality;
  if (!legalityKey && LEGALITY_KEYS.has(body.subformat)) legalityKey = body.subformat;

  const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY) : [];

  // 1. Recuperar reglas y cartas en paralelo
  const names = extractCardNames(question);
  const [context, cards] = await Promise.all([
    Promise.resolve(retrieve(question, format)),
    names.length ? fetchCards(names, legalityKey) : Promise.resolve([]),
  ]);

  // 2. Montar el prompt
  const system = systemPrompt({
    format,
    houseRules,
    legalityKey,
    crEffective: context.meta.effective,
  });

  const contents = [];
  for (const m of history) {
    if (!m || !m.text) continue;
    contents.push({
      role: m.role === "juez" ? "model" : "user",
      parts: [{ text: String(m.text).slice(0, 1500) }],
    });
  }
  contents.push({
    role: "user",
    parts: [
      {
        text:
          buildContext({ rules: context.rules, glossary: context.glossary, cards }) +
          `\n\n=== PREGUNTA DEL JUGADOR ===\n${question}`,
      },
    ],
  });

  // 3. Llamar al modelo
  let answer;
  try {
    answer = await callGemini(env, { system, contents });
  } catch (e) {
    if (e.status === 429) {
      return json(
        env,
        { error: "Se ha agotado la cuota del modelo por ahora. Prueba en un minuto." },
        429
      );
    }
    return json(env, { error: "El modelo ha fallado.", detail: e.detail || e.message }, 502);
  }

  // 4. Devolver tambien el texto literal de las reglas citadas, para que la app
  //    pueda ensenar la fuente y el jugador pueda comprobarla.
  const cited = new Set((answer.reglas_citadas || []).map((s) => s.replace(/^CR\s*/i, "").trim()));
  const fuentes = context.rules
    .filter((r) => cited.has(r.id))
    .map((r) => ({ id: r.id, text: r.text, section: r.section_title }));

  return json(env, {
    ...answer,
    fuentes,
    cartas: cards.map((c) => ({
      query: c.query,
      found: c.found,
      name: c.name,
      printed_name: c.printed_name,
      image: c.image,
      scryfall_uri: c.scryfall_uri,
      legality: c.legality,
    })),
    debug: {
      reglas_recuperadas: context.rules.length,
      ids: context.rules.map((r) => r.id),
      modelo: MODEL,
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(env) });
    }

    if (url.pathname === "/api/health") {
      return json(env, { ok: true, reglas: rulesMeta(), modelo: MODEL });
    }

    if (!authorized(request, env)) {
      return json(env, { error: "Clave del grupo incorrecta." }, 401);
    }

    // Diagnostico: abre https://TU-URL/api/diag?k=TU_CLAVE en el navegador.
    // Dice si la clave de Gemini existe, que modelos ve y que contesta el
    // modelo configurado a una peticion minima.
    if (url.pathname === "/api/diag") {
      const out = { modelo_configurado: MODEL, tiene_clave_gemini: !!env.GEMINI_API_KEY };
      if (!env.GEMINI_API_KEY) {
        out.problema =
          "Falta GEMINI_API_KEY. Panel de Cloudflare > tu Worker > Settings > " +
          "Variables and Secrets > Add, tipo Secret.";
        return json(env, out);
      }
      try {
        const r = await fetch(`${GEMINI}/models?key=${env.GEMINI_API_KEY}`);
        const d = await r.json();
        out.modelos_disponibles = (d.models || [])
          .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
          .map((m) => m.name.replace("models/", ""));
        out.modelo_configurado_disponible = out.modelos_disponibles.includes(MODEL);
      } catch (e) {
        out.error_listando_modelos = String(e).slice(0, 200);
      }
      try {
        await callGemini(env, {
          system: "Responde en JSON segun el esquema.",
          contents: [{ role: "user", parts: [{ text: "Di hola. Cita [CR 100.1]." }] }],
        });
        out.prueba_de_llamada = "OK";
      } catch (e) {
        out.prueba_de_llamada = "FALLA";
        out.detalle = e.detail || String(e);
      }
      return json(env, out);
    }

    if (url.pathname === "/api/models") {
      const res = await fetch(`${GEMINI}/models?key=${env.GEMINI_API_KEY}`);
      const data = await res.json();
      return json(env, {
        modelos: (data.models || [])
          .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
          .map((m) => m.name.replace("models/", "")),
      });
    }

    if (url.pathname === "/api/ask" && request.method === "POST") {
      try {
        return await ask(request, env);
      } catch (e) {
        return json(env, { error: "Error interno.", detail: String(e).slice(0, 300) }, 500);
      }
    }

    return json(env, { error: "Ruta no encontrada." }, 404);
  },
};
