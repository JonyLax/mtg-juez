import { retrieve, rulesMeta } from "./retrieval.js";
import { extractCardNames, fetchCards } from "./scryfall.js";
import { FORMATS, systemPrompt, buildContext, RESPONSE_SCHEMA } from "./prompt.js";

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

// Modelos a probar, en orden. El primero que conteste gana.
// OJO con los alias tipo "gemini-flash-latest": apuntan al Flash mas potente,
// que razona sin limite y puede tardar minutos en una pregunta de reglas. Para
// esto interesa un modelo rapido y predecible. Consulta los que tienes
// disponibles en /api/diag?k=TU_CLAVE.
const MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];

// Techo de razonamiento. Suficiente para encadenar reglas, no tanto como para
// que se quede dando vueltas. Ponlo a 0 para desactivarlo del todo.
const THINKING_BUDGET = 1024;

// Cortamos nosotros antes de que lo haga Cloudflare con un 524 sin explicacion.
const TIMEOUT_MS = 45000;

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";

function fail(message, { status, detail, retryable = false } = {}) {
  const e = new Error(message);
  e.status = status;
  e.detail = detail || message;
  e.retryable = retryable;
  return e;
}

/** Una sola llamada a un modelo concreto. */
async function attempt(env, model, system, contents, thinking) {
  const generationConfig = {
    temperature: 0.15,
    maxOutputTokens: 8192,
    responseMimeType: "application/json",
    responseSchema: RESPONSE_SCHEMA,
  };
  if (thinking && THINKING_BUDGET > 0) {
    generationConfig.thinkingConfig = { thinkingBudget: THINKING_BUDGET };
  }

  let res;
  try {
    res = await fetch(`${GEMINI}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw fail("timeout", {
      status: 504,
      detail: `${model}: sin respuesta en ${TIMEOUT_MS / 1000}s`,
      retryable: true,
    });
  }

  const raw = await res.text();

  if (!res.ok) {
    let msg = raw.slice(0, 300);
    try {
      msg = JSON.parse(raw)?.error?.message || msg;
    } catch {
      /* la respuesta no era JSON */
    }
    // Algunos modelos no aceptan thinkingConfig: reintentamos sin el.
    if (res.status === 400 && thinking && /thinking|thought/i.test(msg)) {
      return attempt(env, model, system, contents, false);
    }
    throw fail(`HTTP ${res.status}`, {
      status: res.status,
      detail: `${model}: HTTP ${res.status} — ${msg}`,
      // Cambiar de modelo solo ayuda si el problema es del modelo o de su cuota
      retryable: res.status === 404 || res.status === 429 || res.status >= 500,
    });
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw fail("ilegible", {
      status: 502,
      detail: `${model}: respuesta no JSON — ${raw.slice(0, 200)}`,
      retryable: true,
    });
  }

  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");

  if (!text) {
    const reason = cand?.finishReason || data.promptFeedback?.blockReason || "desconocido";
    const u = data.usageMetadata || {};
    throw fail("vacia", {
      status: 502,
      detail:
        `${model}: sin texto. finishReason=${reason}. ` +
        `Tokens entrada=${u.promptTokenCount ?? "?"} salida=${u.candidatesTokenCount ?? "?"}` +
        (u.thoughtsTokenCount ? ` razonamiento=${u.thoughtsTokenCount}` : "") +
        (reason === "MAX_TOKENS" ? ". Sube maxOutputTokens en src/index.js." : ""),
      retryable: reason === "MAX_TOKENS",
    });
  }

  try {
    return { answer: JSON.parse(text), model };
  } catch {
    throw fail("esquema", {
      status: 502,
      detail: `${model}: no ha respetado el esquema — ${text.slice(0, 200)}`,
      retryable: true,
    });
  }
}

async function callGemini(env, { system, contents }) {
  if (!env.GEMINI_API_KEY) {
    throw fail("sin clave", {
      status: 500,
      detail:
        "No hay GEMINI_API_KEY configurada. Panel de Cloudflare > tu Worker > " +
        "Settings > Variables and Secrets > Add, tipo Secret.",
    });
  }

  const problemas = [];
  let ultimo;
  for (const model of MODELS) {
    try {
      return await attempt(env, model, system, contents, true);
    } catch (e) {
      problemas.push(e.detail);
      ultimo = e;
      if (!e.retryable) break; // errores de clave o de peticion no mejoran cambiando
    }
  }
  throw fail("gemini", {
    status: ultimo?.status || 502,
    detail: problemas.join("  |  "),
  });
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
  let answer, usedModel;
  try {
    ({ answer, model: usedModel } = await callGemini(env, { system, contents }));
  } catch (e) {
    if (e.status === 429) {
      return json(
        env,
        {
          error: "Se ha agotado la cuota del modelo por ahora. Prueba en un minuto.",
          detail: e.detail,
        },
        429
      );
    }
    if (e.status === 504) {
      return json(
        env,
        { error: "El modelo ha tardado demasiado. Vuelve a intentarlo.", detail: e.detail },
        504
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
      modelo: usedModel,
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
      return json(env, { ok: true, reglas: rulesMeta(), modelos: MODELS });
    }

    if (!authorized(request, env)) {
      return json(env, { error: "Clave del grupo incorrecta." }, 401);
    }

    // Diagnostico: abre https://TU-URL/api/diag?k=TU_CLAVE en el navegador.
    // Dice si la clave de Gemini existe, que modelos ve y que contesta el
    // modelo configurado a una peticion minima.
    if (url.pathname === "/api/diag") {
      const out = { modelos_configurados: MODELS, tiene_clave_gemini: !!env.GEMINI_API_KEY };
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
        out.configurados_disponibles = MODELS.filter((m) =>
          out.modelos_disponibles.includes(m)
        );
      } catch (e) {
        out.error_listando_modelos = String(e).slice(0, 200);
      }
      try {
        const t0 = Date.now();
        const r = await callGemini(env, {
          system: "Eres un juez de Magic. Responde en JSON segun el esquema.",
          contents: [
            { role: "user", parts: [{ text: "Saluda en una frase y cita [CR 100.1]." }] },
          ],
        });
        out.prueba_de_llamada = "OK";
        out.modelo_que_respondio = r.model;
        out.tardo_ms = Date.now() - t0;
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
