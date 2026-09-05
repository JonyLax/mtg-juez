import { retrieve, rulesMeta } from "./retrieval.js";
import { extractCardNames, fetchCards } from "./scryfall.js";
import {
  FORMATS, systemPrompt, buildContext, RESPONSE_SCHEMA,
  planPrompt, PLAN_SCHEMA, mazoPrompt, MAZO_SCHEMA,
} from "./prompt.js";
import {
  ejecutarPlan, combosCon, contextoDeCartas, fichaCarta, revisarMazo,
  cuadrarMazo, preciosDe, TAMANO_MAZO,
} from "./deck.js";
import { manejarAuth, usuarioActual } from "./auth.js";
import { sugerir } from "./cards.js";
import { consumir, saldo } from "./limits.js";
import { esSubdominioChat, servirWeb, IDIOMAS_WEB } from "./routing.js";

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
    // Sin esto el navegador aplica cache heuristica a las respuestas de la API
    // y puedes acabar mirando el resultado de un despliegue anterior.
    "Cache-Control": "no-store, max-age=0",
    ...extra,
  };
}

const json = (env, body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: cors(env, { "Content-Type": "application/json; charset=utf-8" }),
  });

// Sube este numero al tocar el fichero. Sirve para saber de un vistazo, en
// /api/health y /api/diag, si lo que hay desplegado es lo que crees.
const VERSION = 22;

// Modelos a probar, en orden. El primero que conteste gana.
// Google retira modelos para claves nuevas sin quitarlos del catalogo: la lista
// de /api/diag puede incluir modelos que devuelven 404 al usarlos. Si eso pasa,
// el propio error de Google te dice cual es el sustituto.
const MODELS = ["gemini-3.6-flash", "gemini-3.5-flash-lite"];

// Techo de razonamiento. Sin el, los modelos Flash potentes se ponen a pensar
// sin limite y la peticion muere por tiempo de espera.
// La generacion 2.5 lo expresa en tokens (thinkingBudget) y la 3 en niveles
// (thinkingLevel), asi que probamos ambos y, si ninguno cuela, vamos sin techo.
const THINKING_BUDGET = 1024;
const THINKING_LEVEL = "low";
const THINKING_MODES = ["budget", "level", "none"];

// Cortamos nosotros antes de que lo haga Cloudflare con un 524 sin explicacion.
const TIMEOUT_MS = 30000;

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";

function fail(message, { status, detail, retryable = false } = {}) {
  const e = new Error(message);
  e.status = status;
  e.detail = detail || message;
  e.retryable = retryable;
  return e;
}

/** Una sola llamada a un modelo concreto, con un modo de razonamiento dado. */
async function attempt(env, model, system, contents, modeIndex = 0, esquema = RESPONSE_SCHEMA) {
  const mode = THINKING_MODES[modeIndex];

  const generationConfig = {
    temperature: 0.15,
    maxOutputTokens: 8192,
    responseMimeType: "application/json",
    responseSchema: esquema,
  };
  if (mode === "budget" && THINKING_BUDGET > 0) {
    generationConfig.thinkingConfig = { thinkingBudget: THINKING_BUDGET };
  } else if (mode === "level") {
    generationConfig.thinkingConfig = { thinkingLevel: THINKING_LEVEL };
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
      detail: `${model} (${mode}): sin respuesta en ${TIMEOUT_MS / 1000}s`,
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
    // Este modelo no entiende esta forma de acotar el razonamiento: pasamos a
    // la siguiente de la cascada (budget -> level -> sin techo).
    if (
      res.status === 400 &&
      modeIndex < THINKING_MODES.length - 1 &&
      /thinking|thought/i.test(msg)
    ) {
      return attempt(env, model, system, contents, modeIndex + 1, esquema);
    }
    throw fail(`HTTP ${res.status}`, {
      status: res.status,
      detail: `${model} (${mode}): HTTP ${res.status} — ${msg}`,
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
      detail: `${model} (${mode}): respuesta no JSON — ${raw.slice(0, 200)}`,
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
        `${model} (${mode}): sin texto. finishReason=${reason}. ` +
        `Tokens entrada=${u.promptTokenCount ?? "?"} salida=${u.candidatesTokenCount ?? "?"}` +
        (u.thoughtsTokenCount ? ` razonamiento=${u.thoughtsTokenCount}` : "") +
        (reason === "MAX_TOKENS" ? ". Sube maxOutputTokens en src/index.js." : ""),
      retryable: reason === "MAX_TOKENS",
    });
  }

  try {
    return { answer: JSON.parse(text), model, thinking: mode };
  } catch {
    throw fail("esquema", {
      status: 502,
      detail: `${model} (${mode}): no ha respetado el esquema — ${text.slice(0, 200)}`,
      retryable: true,
    });
  }
}

async function callGemini(env, { system, contents, esquema = RESPONSE_SCHEMA }) {
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
      return await attempt(env, model, system, contents, 0, esquema);
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

async function ask(request, env, usuario) {
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
    names.length ? fetchCards(env, names, legalityKey) : Promise.resolve([]),
  ]);

  // 2. Montar el prompt
  const system = systemPrompt({
    format,
    houseRules,
    legalityKey,
    crEffective: context.meta.effective,
    lang: usuario?.lang || "es",
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

/**
 * Modo mazo, en dos vueltas.
 *   1. El modelo traduce la peticion a busquedas de Scryfall. No nombra cartas.
 *   2. El Worker las ejecuta y le devuelve cartas reales, con precio de la
 *      impresion mas barata, identidad de color y legalidad comprobadas.
 *   3. El modelo compone el mazo eligiendo SOLO de esas cartas.
 * Despues comprobamos que no se ha inventado ninguna y que respeta los limites.
 */
async function mazo(request, env, usuario) {
  const body = await request.json();
  const pregunta = String(body.question || "").slice(0, MAX_QUESTION).trim();
  if (!pregunta) return json(env, { error: "Falta la pregunta." }, 400);

  const lang = usuario?.lang || "es";
  const historia = (Array.isArray(body.history) ? body.history : []).slice(-6);
  const contents = historia
    .filter((m) => m?.text)
    .map((m) => ({ role: m.role === "juez" ? "model" : "user", parts: [{ text: String(m.text).slice(0, 1200) }] }));

  // ── Vuelta 1: el plan ──
  let plan;
  try {
    const r = await callGemini(env, {
      system: planPrompt({ lang }),
      contents: [...contents, { role: "user", parts: [{ text: pregunta }] }],
      esquema: PLAN_SCHEMA,
    });
    plan = r.answer;
  } catch (e) {
    return json(env, { error: "No he podido entender la peticion.", detail: e.detail }, 502);
  }

  if ((plan.falta_info || []).length && !(plan.busquedas || []).length) {
    return json(env, {
      modo: "mazo",
      tipo: "clarificacion",
      texto: plan.entendido || "Necesito un par de datos antes de empezar.",
      opciones: plan.falta_info.slice(0, 4),
    });
  }

  // ── La identidad de color sale de la carta del comandante, no del modelo ──
  const moneda = plan.moneda === "usd" ? "usd" : "eur";
  const limites = {
    formato: plan.formato || "commander",
    bracket: plan.bracket || null,
    presupuesto: plan.presupuesto_total || null,
    comandante: plan.comandante || null,
    moneda,
  };

  let comandante = null;
  if (plan.comandante) {
    comandante = await fichaCarta(plan.comandante, moneda);
    if (comandante) {
      limites.comandante = comandante.nombre;
      limites.identidad = (comandante.identidad_lista || []).join("") || "c";
    }
  }
  // Los brackets 1 y 2 no admiten ningun game changer: se excluyen en la busqueda
  limites.sinGamechangers = limites.bracket === 1 || limites.bracket === 2;
  // Tope por carta. Generoso a proposito: un mazo de 200 EUR puede llevar
  // perfectamente una pieza de 50 y noventa cartas de dos. Lo que evita este
  // tope es que la busqueda devuelva cartas de 300 que no caben de ninguna
  // forma; el reparto fino lo hace el modelo y lo comprueba revisarMazo().
  if (limites.presupuesto) {
    limites.presupuestoCarta = Math.max(3, Math.round(limites.presupuesto * 0.35 * 100) / 100);
  }

  // ── Vuelta 2: cartas reales ──
  const [resultados, combos] = await Promise.all([
    ejecutarPlan(plan, limites),
    combosCon(plan.cartas_mencionadas || [], limites.identidad),
  ]);

  const disponibles = new Map();
  for (const r of resultados) for (const c of r.cartas) disponibles.set(c.nombre.toLowerCase(), c);
  if (comandante) disponibles.set(comandante.nombre.toLowerCase(), comandante);

  if (!disponibles.size) {
    return json(env, {
      modo: "mazo",
      tipo: "sugerencias",
      texto: "No he encontrado cartas que cumplan a la vez el presupuesto, el formato y la identidad de color. Prueba a subir el presupuesto o a aflojar alguna condicion.",
      avisos: [`Busquedas probadas: ${resultados.map((r) => r.consulta).join(" | ")}`],
    });
  }

  let respuesta;
  try {
    const r = await callGemini(env, {
      system: mazoPrompt({ lang, limites, intencion: plan.intencion }),
      contents: [{
        role: "user",
        parts: [{ text: contextoDeCartas(resultados, combos, moneda) + `\n\n=== PETICION ===\n${pregunta}` }],
      }],
      esquema: MAZO_SCHEMA,
    });
    respuesta = r.answer;
  } catch (e) {
    return json(env, { error: "El modelo ha fallado al componer el mazo.", detail: e.detail }, 502);
  }

  // ── Cuadrar el mazo: los modelos no saben contar ──
  // Si el modelo se salta la lista final, la reconstruimos a partir de las
  // secciones. Antes, sin lista no se cuadraba nada y el mazo salia corto sin
  // que nadie lo dijera.
  let lista = respuesta.lista || [];
  if (!lista.length && (respuesta.secciones || []).length) {
    lista = [];
    for (const sec of respuesta.secciones) {
      for (const c of sec.cartas || []) {
        if (c?.nombre) lista.push(`${c.cuantas || 1} ${c.nombre}`);
      }
    }
    respuesta.lista_reconstruida = true;
  }
  const cuadre = lista.length && plan.intencion === "construir"
    ? cuadrarMazo(lista, limites)
    : null;

  // ── Precio del mazo ENTERO, no solo de las cartas explicadas ──
  // Antes solo se sumaban las que el modelo se molestaba en comentar, asi que
  // el total salia muy por debajo del coste real.
  let precios = new Map();
  const noBasicas = (cuadre?.entradas || [])
    .filter((e) => !/^(Snow-Covered )?(Plains|Island|Swamp|Mountain|Forest|Wastes)$/.test(e.nombre))
    .map((e) => e.nombre);
  if (noBasicas.length) {
    try {
      precios = await preciosDe(noBasicas.slice(0, 120), moneda);
    } catch { /* si falla, caemos a los precios que ya teniamos */ }
  }
  const dato = (nombre) =>
    precios.get((nombre || "").toLowerCase()) || disponibles.get((nombre || "").toLowerCase()) || null;

  // ── Comprobacion: nada de cartas inventadas ──
  const inventadas = [];
  for (const sec of respuesta.secciones || []) {
    for (const c of sec.cartas || []) {
      const real = dato(c.nombre);
      if (real) {
        c.precio = real.precio;
        c.gamechanger = real.gamechanger;
        c.uri = real.uri;
      } else {
        inventadas.push(c.nombre);
        c.inventada = true;
      }
    }
  }

  // El mazo real es la lista, no las cartas comentadas
  const delMazo = [];
  const sinConfirmar = [];
  for (const e of cuadre?.entradas || []) {
    if (/^(Snow-Covered )?(Plains|Island|Swamp|Mountain|Forest|Wastes)$/.test(e.nombre)) continue;
    const real = dato(e.nombre);
    if (real) for (let i = 0; i < e.cuantas; i++) delMazo.push(real);
    else sinConfirmar.push(e.nombre);
  }

  const revision = revisarMazo(delMazo, limites);
  const avisos = [...(respuesta.avisos || []), ...(cuadre?.avisos || []), ...revision.avisos];
  const notas = revision.notas || [];
  const noConfirmadas = [...new Set([...inventadas, ...sinConfirmar])];
  if (noConfirmadas.length) {
    avisos.unshift(
      `No he podido confirmar estas cartas en Scryfall: ${noConfirmadas.join(", ")}.`
    );
  }

  return json(env, {
    modo: "mazo",
    ...respuesta,
    lista: cuadre?.lista || respuesta.lista || [],
    tierras_basicas: cuadre?.basicas ?? respuesta.tierras_basicas,
    limites: {
      formato: limites.formato,
      comandante: limites.comandante,
      identidad: limites.identidad,
      bracket: limites.bracket,
      presupuesto: limites.presupuesto,
      moneda,
    },
    resumen: {
      total: revision.total,
      gamechangers: revision.gamechangers,
      cartas: cuadre?.total ?? delMazo.length,
      objetivo: cuadre?.objetivo ?? TAMANO_MAZO[limites.formato],
      confirmadas: delMazo.length,
    },
    avisos,
    notas,
    debug: { busquedas: resultados.map((r) => `${r.para}: ${r.consulta} (${r.total})`), combos: combos.length },
  });
}

/** Cuela el saldo restante en la respuesta, para que la interfaz lo pinte. */
async function conCupo(respuesta, cupo) {
  if (cupo.sinControl || respuesta.status !== 200) return respuesta;
  try {
    const cuerpo = await respuesta.json();
    return new Response(
      JSON.stringify({ ...cuerpo, cupo: { restantes: cupo.restantes, limite: cupo.limite } }),
      { status: 200, headers: respuesta.headers }
    );
  } catch {
    return respuesta;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(env) });
    }

    // ── Enrutado del sitio ────────────────────────────────────────────────
    // La API responde igual en los dos dominios; lo que cambia es qué HTML
    // se sirve cuando la ruta no es de la API.
    if (!url.pathname.startsWith("/api/")) {
      if (esSubdominioChat(url.hostname)) {
        // El chat: cualquier ruta que no sea un fichero devuelve la app, para
        // que /?reset=… y demás enlaces de correo funcionen.
        const activo = await env.ASSETS.fetch(request);
        if (activo.status !== 404) return activo;
        return env.ASSETS.fetch(new URL("/app.html", url.origin));
      }
      const web = await servirWeb(request, env, url);
      if (web) return web;
      return env.ASSETS.fetch(request);
    }

    // Registro, verificación, sesión y contraseñas
    if (url.pathname.startsWith("/api/auth/")) {
      try {
        return await manejarAuth(request, env, url);
      } catch (e) {
        return json(env, { error: "Error en la autenticación.", detail: String(e).slice(0, 300) }, 500);
      }
    }

    if (url.pathname === "/api/health") {
      const sesion = env.DB ? await usuarioActual(request, env) : null;
      // Comprobamos que la web comercial esta realmente publicada. Si el paso
      // que la genera falla, aqui se ve enseguida en vez de dar un 404 mudo.
      const web = {};
      for (const l of IDIOMAS_WEB) {
        try {
          const r = await env.ASSETS.fetch(new URL(`/${l}/index.html`, url.origin));
          web[l] = r.status;
        } catch (e) {
          web[l] = String(e).slice(0, 60);
        }
      }
      return json(env, {
        ok: true,
        version: VERSION,
        web,
        cuentas: !!env.DB,
        usuario: sesion?.username || null,
        reglas: rulesMeta(),
        modelos: MODELS,
      });
    }

    // Diagnostico. Hay que haber iniciado sesion: se abre desde el navegador
    // con la cookie ya puesta.
    if (url.pathname === "/api/diag" || url.pathname === "/api/models") {
      if (env.DB && !(await usuarioActual(request, env))) {
        return json(env, { error: "Inicia sesion en la app y vuelve a abrir esta direccion." }, 401);
      }
    }

    if (url.pathname === "/api/diag") {
      const out = {
        version: VERSION,
        modelos_configurados: MODELS,
        tiene_clave_gemini: !!env.GEMINI_API_KEY,
      };
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
        out.modo_de_razonamiento = r.thinking;
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

    // Autocompletado de nombres de carta mientras se escribe
    if (url.pathname === "/api/cards/suggest") {
      if (env.DB && !(await usuarioActual(request, env))) {
        return json(env, { error: "Sin sesión." }, 401);
      }
      try {
        return json(env, { sugerencias: await sugerir(env, url.searchParams.get("q")) });
      } catch (e) {
        return json(env, { sugerencias: [] });
      }
    }

    if (url.pathname === "/api/deck" && request.method === "POST") {
      try {
        let u = null;
        if (env.DB) {
          u = await usuarioActual(request, env);
          if (!u) return json(env, { error: "Tu sesión ha caducado. Vuelve a entrar.", codigo: "sin-sesion" }, 401);
        }
        const cupoM = await consumir(env, u, "mazo");
        if (!cupoM.ok) {
          return json(env, { error: cupoM.mensaje, codigo: `cupo-${cupoM.motivo}`, cupo: cupoM }, 429);
        }
        const rm = await mazo(request, env, u);
        return conCupo(rm, cupoM);
      } catch (e) {
        return json(env, { error: "Error interno.", detail: String(e).slice(0, 300) }, 500);
      }
    }

    if (url.pathname === "/api/ask" && request.method === "POST") {
      try {
        // Con base de datos configurada, hay que haber iniciado sesión
        let usuarioSesion = null;
        if (env.DB) {
          usuarioSesion = await usuarioActual(request, env);
          if (!usuarioSesion) {
            return json(env, { error: "Tu sesión ha caducado. Vuelve a entrar.", codigo: "sin-sesion" }, 401);
          }
        }
        const cupo = await consumir(env, usuarioSesion, "reglas");
        if (!cupo.ok) {
          return json(env, { error: cupo.mensaje, codigo: `cupo-${cupo.motivo}`, cupo }, 429);
        }
        const r = await ask(request, env, usuarioSesion);
        return conCupo(r, cupo);
      } catch (e) {
        return json(env, { error: "Error interno.", detail: String(e).slice(0, 300) }, 500);
      }
    }

    return json(env, { error: "Ruta no encontrada." }, 404);
  },
};
