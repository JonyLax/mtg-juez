import { enviarVerificacion, enviarRestablecimiento, enviarCambioCorreo } from "./mail.js";
import { saldo } from "./limits.js";

// ─────────────────────────────────────────────────────────────────────────────
// POR QUÉ LAS CONTRASEÑAS SE ESTIRAN EN EL NAVEGADOR
//
// El plan gratuito de Workers da 10 ms de CPU por petición. Medido en este
// mismo entorno: PBKDF2-SHA256 con 50.000 iteraciones ya cuesta 8,9 ms y con
// 600.000 (lo que recomienda OWASP) se va a 102 ms. Hacer el estirado entero
// en el servidor haría caer la petición con error 1102.
//
// Solución: el navegador hace las 600.000 iteraciones (le cuesta unos 100 ms,
// una sola vez) y manda la clave derivada. El servidor NO la guarda tal cual:
// le aplica otras 12.000 iteraciones (unos 2 ms) y encima un HMAC con una
// pimienta que vive solo en los secretos del Worker.
//
// Qué protege esto: si alguien se lleva la base de datos, para sacar una
// contraseña real tiene que romper 612.000 iteraciones Y conocer la pimienta,
// que no está en la base de datos. Es el mismo factor de trabajo que
// recomienda OWASP, solo que repartido.
// ─────────────────────────────────────────────────────────────────────────────

export const KDF_ITERATIONS = 600000; // las que hace el navegador
const SERVER_ITERATIONS = 8000; // las que añade el Worker
const SESSION_DAYS = 30;
const VERIFY_HOURS = 24;
const RESET_HOURS = 1;
const MIN_PASS = 10; // longitud mínima, se valida también en el navegador
const DIAS_CAMBIO_USUARIO = 30; // cada cuánto se puede cambiar el nombre
const IDIOMAS_VALIDOS = ["es", "en", "pt", "fr", "de", "it"];

const enc = new TextEncoder();
const ahora = () => Math.floor(Date.now() / 1000);

// ── utilidades de bytes ──────────────────────────────────────────────────────
const hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function aleatorio(bytes = 32) {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256hex(s) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/** Comparación en tiempo constante: no revela en qué carácter falla. */
function igual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

async function hmac(clave, mensaje) {
  const k = await crypto.subtle.importKey(
    "raw", enc.encode(clave), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(mensaje)));
}

async function pbkdf2(material, sal, iteraciones) {
  const k = await crypto.subtle.importKey("raw", enc.encode(material), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(sal), iterations: iteraciones }, k, 256
  ));
}

/** Lo que acaba guardado en la columna pass_hash. */
async function hashDeServidor(env, dk, sal) {
  const estirado = await pbkdf2(dk, sal + "|juez", SERVER_ITERATIONS);
  return hmac(env.AUTH_PEPPER, estirado);
}

// ── validación de entrada ────────────────────────────────────────────────────
const RE_USER = /^[a-zA-Z0-9_.-]{3,24}$/;
const RE_MAIL = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
const RE_DK = /^[0-9a-f]{64}$/;
const RE_SAL = /^[0-9a-f]{32}$/;

// ── límite de intentos ───────────────────────────────────────────────────────
async function permitido(env, bucket, maximo, ventanaSeg) {
  const t = ahora();
  const fila = await env.DB.prepare("SELECT count, reset_at FROM attempts WHERE bucket = ?")
    .bind(bucket).first();
  if (!fila || fila.reset_at < t) {
    await env.DB.prepare(
      "INSERT INTO attempts (bucket, count, reset_at) VALUES (?, 1, ?) " +
      "ON CONFLICT(bucket) DO UPDATE SET count = 1, reset_at = excluded.reset_at"
    ).bind(bucket, t + ventanaSeg).run();
    return true;
  }
  if (fila.count >= maximo) return false;
  await env.DB.prepare("UPDATE attempts SET count = count + 1 WHERE bucket = ?").bind(bucket).run();
  return true;
}

async function limpiarIntentos(env, bucket) {
  await env.DB.prepare("DELETE FROM attempts WHERE bucket = ?").bind(bucket).run();
}

// ── sesiones ─────────────────────────────────────────────────────────────────
const COOKIE = "juez_sid";

function cabeceraCookie(token, segundos, request) {
  const partes = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${segundos}`,
  ];
  // La sesion tiene que sobrevivir al salto de mtg-juez.com a
  // chat.mtg-juez.com, asi que la cookie se emite para el dominio padre.
  // En workers.dev y en localhost no se puede, y tampoco hace falta.
  const host = new URL(request.url).hostname;
  const m = host.match(/([a-z0-9-]+\.[a-z]{2,})$/i);
  if (m && !host.endsWith(".workers.dev") && host !== "localhost") {
    partes.push(`Domain=.${m[1]}`);
  }
  return partes.join("; ");
}

function leerCookie(request) {
  const bruto = request.headers.get("Cookie") || "";
  for (const trozo of bruto.split(";")) {
    const [k, ...v] = trozo.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

async function crearSesion(env, userId) {
  const token = aleatorio(32);
  const h = await sha256hex(token);
  const t = ahora();
  await env.DB.prepare(
    "INSERT INTO sessions (hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(h, userId, t, t + SESSION_DAYS * 86400).run();
  return token;
}

/** Devuelve el usuario de la sesión, o null. Se usa para proteger /api/ask. */
export async function usuarioActual(request, env) {
  if (!env.DB) return null;
  const token = leerCookie(request);
  if (!token) return null;
  const fila = await env.DB.prepare(
    "SELECT u.id, u.username, u.email, u.lang, u.username_changed_at, u.created_at, " +
    "u.tour_visto, u.plan, s.expires_at " +
    "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ?"
  ).bind(await sha256hex(token)).first();
  if (!fila || fila.expires_at < ahora()) return null;
  return {
    id: fila.id,
    username: fila.username,
    email: fila.email,
    lang: fila.lang || "es",
    username_changed_at: fila.username_changed_at,
    created_at: fila.created_at,
    tour_visto: !!fila.tour_visto,
    plan: fila.plan || "free",
  };
}

/** Momento a partir del cual puede volver a cambiarse el nombre de usuario. */
function proximoCambio(u) {
  const ultimo = u.username_changed_at;
  return ultimo ? ultimo + DIAS_CAMBIO_USUARIO * 86400 : 0;
}

// ── enlaces de un solo uso ───────────────────────────────────────────────────
async function crearToken(env, userId, kind, horas, payload = null) {
  const token = aleatorio(32);
  await env.DB.prepare("DELETE FROM tokens WHERE user_id = ? AND kind = ?")
    .bind(userId, kind).run();
  await env.DB.prepare(
    "INSERT INTO tokens (hash, user_id, kind, expires_at, payload) VALUES (?, ?, ?, ?, ?)"
  ).bind(await sha256hex(token), userId, kind, ahora() + horas * 3600, payload).run();
  return token;
}

async function consumirToken(env, token, kind) {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  const h = await sha256hex(token);
  const fila = await env.DB.prepare(
    "SELECT user_id, expires_at, used, payload FROM tokens WHERE hash = ? AND kind = ?"
  ).bind(h, kind).first();
  if (!fila || fila.used || fila.expires_at < ahora()) return null;
  await env.DB.prepare("DELETE FROM tokens WHERE hash = ?").bind(h).run();
  return { userId: fila.user_id, payload: fila.payload };
}

// ── respuestas ───────────────────────────────────────────────────────────────
const json = (cuerpo, status = 200, extra = {}) =>
  new Response(JSON.stringify(cuerpo), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    },
  });

function baseUrl(request) {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rutas
// ─────────────────────────────────────────────────────────────────────────────
export async function manejarAuth(request, env, url) {
  if (!env.DB) {
    return json({ error: "Falta la base de datos. Revisa el enlace D1 en wrangler.toml." }, 500);
  }
  const ruta = url.pathname.replace("/api/auth/", "");
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";

  let cuerpo = {};
  if (request.method === "POST") {
    try { cuerpo = await request.json(); } catch { cuerpo = {}; }
  }

  // ── quién soy ──────────────────────────────────────────────────────────────
  if (ruta === "me") {
    const u = await usuarioActual(request, env);
    if (!u) return json({ error: "Sin sesión." }, 401);
    return json({
      usuario: { ...u, puede_cambiar_usuario_el: proximoCambio(u) },
      cupo: await saldo(env, u),
    });
  }

  // ── guía de bienvenida vista (o saltada) ───────────────────────────────────
  // Se guarda en la cuenta, no en el navegador: así no reaparece al entrar
  // desde el móvil, y volver a verla es una opción de Ajustes.
  if (ruta === "tour" && request.method === "POST") {
    const u = await usuarioActual(request, env);
    if (!u) return json({ error: "Sin sesión." }, 401);
    const visto = cuerpo.visto === false ? null : ahora();
    await env.DB.prepare("UPDATE users SET tour_visto = ? WHERE id = ?").bind(visto, u.id).run();
    return json({ ok: true, tour_visto: !!visto });
  }

  // ── ajustes: idioma de las respuestas ──────────────────────────────────────
  if (ruta === "lang" && request.method === "POST") {
    const u = await usuarioActual(request, env);
    if (!u) return json({ error: "Sin sesión." }, 401);
    const lang = String(cuerpo.lang || "");
    if (!IDIOMAS_VALIDOS.includes(lang)) return json({ error: "Idioma no admitido." }, 400);
    await env.DB.prepare("UPDATE users SET lang = ? WHERE id = ?").bind(lang, u.id).run();
    return json({ ok: true, lang });
  }

  // ── ajustes: cambiar el nombre de usuario ──────────────────────────────────
  if (ruta === "username" && request.method === "POST") {
    const u = await usuarioActual(request, env);
    if (!u) return json({ error: "Sin sesión." }, 401);

    const nuevo = String(cuerpo.username || "").trim();
    if (!RE_USER.test(nuevo)) {
      return json({ error: "El usuario debe tener entre 3 y 24 caracteres: letras, números, punto, guion o guion bajo." }, 400);
    }
    if (nuevo.toLowerCase() === u.username.toLowerCase()) {
      // Solo cambia de mayúsculas: no gasta el cupo de 30 días
      await env.DB.prepare("UPDATE users SET username = ? WHERE id = ?").bind(nuevo, u.id).run();
      return json({ ok: true, username: nuevo, puede_cambiar_usuario_el: proximoCambio(u) });
    }

    const proximo = proximoCambio(u);
    if (proximo > ahora()) {
      return json({
        error: `Solo puedes cambiar el nombre una vez cada ${DIAS_CAMBIO_USUARIO} días.`,
        proximo_cambio: proximo,
      }, 429);
    }

    const cogido = await env.DB.prepare("SELECT id FROM users WHERE username_lc = ?")
      .bind(nuevo.toLowerCase()).first();
    if (cogido) return json({ error: "Ese nombre de usuario ya está cogido." }, 409);

    const t = ahora();
    await env.DB.prepare(
      "UPDATE users SET username = ?, username_lc = ?, username_changed_at = ? WHERE id = ?"
    ).bind(nuevo, nuevo.toLowerCase(), t, u.id).run();

    return json({
      ok: true,
      username: nuevo,
      puede_cambiar_usuario_el: t + DIAS_CAMBIO_USUARIO * 86400,
    });
  }

  // ── ajustes: cambiar la contraseña ─────────────────────────────────────────
  if (ruta === "password" && request.method === "POST") {
    const u = await usuarioActual(request, env);
    if (!u) return json({ error: "Sin sesión." }, 401);

    const actual = String(cuerpo.dk_actual || "");
    const salt = String(cuerpo.salt || "");
    const dk = String(cuerpo.dk || "");
    if (!RE_DK.test(actual)) return json({ error: "Falta la contraseña actual." }, 400);
    if (!RE_SAL.test(salt) || !RE_DK.test(dk)) {
      return json({ error: "La contraseña nueva no se ha preparado bien. Recarga la página." }, 400);
    }
    if (!(await permitido(env, `pass:${u.id}`, 5, 900))) {
      return json({ error: "Demasiados intentos. Espera un cuarto de hora." }, 429);
    }

    const fila = await env.DB.prepare("SELECT salt, pass_hash FROM users WHERE id = ?")
      .bind(u.id).first();
    if (!fila || !igual(await hashDeServidor(env, actual, fila.salt), fila.pass_hash)) {
      return json({ error: "La contraseña actual no es correcta." }, 401);
    }

    await env.DB.prepare(
      "UPDATE users SET salt = ?, pass_hash = ?, kdf_iterations = ? WHERE id = ?"
    ).bind(salt, await hashDeServidor(env, dk, salt), Number(cuerpo.iterations) || KDF_ITERATIONS, u.id).run();

    // Cierra las sesiones de otros dispositivos, pero deja abierta esta.
    const actualHash = await sha256hex(leerCookie(request) || "");
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND hash != ?")
      .bind(u.id, actualHash).run();

    return json({ ok: true });
  }

  // ── ajustes: cambiar el correo ─────────────────────────────────────────────
  // El enlace de confirmación va a la dirección ACTUAL, no a la nueva: así,
  // si alguien te pilla la sesión abierta, no puede llevarse la cuenta a un
  // correo suyo sin que tú lo veas.
  if (ruta === "email" && request.method === "POST") {
    const u = await usuarioActual(request, env);
    if (!u) return json({ error: "Sin sesión." }, 401);

    const nuevo = String(cuerpo.email || "").trim();
    const dk = String(cuerpo.dk || "");
    if (!RE_MAIL.test(nuevo)) return json({ error: "Ese correo no tiene buena pinta." }, 400);
    if (nuevo.toLowerCase() === u.email.toLowerCase()) {
      return json({ error: "Ese ya es tu correo." }, 400);
    }
    if (!RE_DK.test(dk)) return json({ error: "Falta la contraseña." }, 400);
    if (!(await permitido(env, `mail:${u.id}`, 5, 3600))) {
      return json({ error: "Demasiados intentos. Prueba dentro de un rato." }, 429);
    }

    const fila = await env.DB.prepare("SELECT salt, pass_hash FROM users WHERE id = ?")
      .bind(u.id).first();
    if (!fila || !igual(await hashDeServidor(env, dk, fila.salt), fila.pass_hash)) {
      return json({ error: "La contraseña no es correcta." }, 401);
    }

    const cogido = await env.DB.prepare("SELECT id FROM users WHERE email_lc = ?")
      .bind(nuevo.toLowerCase()).first();
    // Mismo criterio que en el registro: no decimos si ese correo tiene cuenta.
    if (!cogido) {
      try {
        const t = await crearToken(env, u.id, "email", RESET_HOURS, nuevo);
        await enviarCambioCorreo(env, {
          to: u.email,
          username: u.username,
          nuevo,
          enlace: `${baseUrl(request)}/api/auth/confirm-email?token=${t}`,
        });
      } catch (e) {
        return json({ error: "No he podido enviar el correo.", detail: String(e).slice(0, 200) }, 502);
      }
    }
    return json({ ok: true, mensaje: "revisa-tu-correo-actual" });
  }

  // ── confirmación del cambio de correo ──────────────────────────────────────
  if (ruta === "confirm-email" && request.method === "GET") {
    const t = await consumirToken(env, url.searchParams.get("token"), "email");
    if (!t?.userId || !t.payload) {
      return Response.redirect(`${baseUrl(request)}/?aviso=enlace-caducado`, 302);
    }
    const cogido = await env.DB.prepare("SELECT id FROM users WHERE email_lc = ?")
      .bind(t.payload.toLowerCase()).first();
    if (cogido) {
      return Response.redirect(`${baseUrl(request)}/?aviso=correo-ocupado`, 302);
    }
    await env.DB.prepare("UPDATE users SET email = ?, email_lc = ? WHERE id = ?")
      .bind(t.payload, t.payload.toLowerCase(), t.userId).run();
    return Response.redirect(`${baseUrl(request)}/?aviso=correo-cambiado`, 302);
  }

  // ── ajustes: dar de baja la cuenta ─────────────────────────────────────────
  // Pedimos la contraseña: si alguien te deja la sesión abierta, que no pueda
  // borrarte la cuenta de un clic.
  if (ruta === "delete" && request.method === "POST") {
    const u = await usuarioActual(request, env);
    if (!u) return json({ error: "Sin sesión." }, 401);

    const dk = String(cuerpo.dk || "");
    if (!RE_DK.test(dk)) return json({ error: "Falta la contraseña." }, 400);
    if (!(await permitido(env, `del:${u.id}`, 5, 900))) {
      return json({ error: "Demasiados intentos. Espera un cuarto de hora." }, 429);
    }

    const fila = await env.DB.prepare("SELECT salt, pass_hash FROM users WHERE id = ?")
      .bind(u.id).first();
    if (!fila || !igual(await hashDeServidor(env, dk, fila.salt), fila.pass_hash)) {
      return json({ error: "La contraseña no es correcta." }, 401);
    }

    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(u.id),
      env.DB.prepare("DELETE FROM tokens WHERE user_id = ?").bind(u.id),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(u.id),
    ]);

    return json({ ok: true }, 200, { "Set-Cookie": cabeceraCookie("", 0, request) });
  }

  // ── parámetros del estirado, antes de iniciar sesión ───────────────────────
  // Para un usuario que no existe devolvemos una sal falsa pero estable,
  // derivada de la pimienta. Así no se puede averiguar quién está registrado.
  if (ruta === "salt") {
    const login = String(cuerpo.login || "").trim().toLowerCase();
    if (!login) return json({ error: "Falta el usuario." }, 400);
    const fila = await env.DB.prepare(
      "SELECT salt, kdf_iterations FROM users WHERE username_lc = ? OR email_lc = ?"
    ).bind(login, login).first();
    if (fila) return json({ salt: fila.salt, iterations: fila.kdf_iterations });
    const falsa = (await hmac(env.AUTH_PEPPER, "sal-falsa:" + login)).slice(0, 32);
    return json({ salt: falsa, iterations: KDF_ITERATIONS });
  }

  // ── registro ───────────────────────────────────────────────────────────────
  if (ruta === "register" && request.method === "POST") {
    if (!(await permitido(env, `reg:${ip}`, 5, 3600))) {
      return json({ error: "Demasiadas cuentas desde aquí. Prueba dentro de un rato." }, 429);
    }

    const username = String(cuerpo.username || "").trim();
    const email = String(cuerpo.email || "").trim();
    const salt = String(cuerpo.salt || "");
    const dk = String(cuerpo.dk || "");

    if (!RE_USER.test(username)) {
      return json({ error: "El usuario debe tener entre 3 y 24 caracteres: letras, números, punto, guion o guion bajo." }, 400);
    }
    if (!RE_MAIL.test(email)) return json({ error: "Ese correo no tiene buena pinta." }, 400);
    if (!RE_SAL.test(salt) || !RE_DK.test(dk)) {
      return json({ error: "La contraseña no se ha preparado bien en el navegador. Recarga la página." }, 400);
    }

    const username_lc = username.toLowerCase();
    const email_lc = email.toLowerCase();
    const existente = await env.DB.prepare(
      "SELECT id, username, email, verified FROM users WHERE username_lc = ? OR email_lc = ?"
    ).bind(username_lc, email_lc).first();

    if (existente) {
      // El nombre de usuario sí se puede decir: es público y hace falta para
      // elegir uno. El correo no, porque delataría quién tiene cuenta.
      if (existente.username.toLowerCase() === username_lc) {
        return json({ error: "Ese nombre de usuario ya está cogido." }, 409);
      }
      // Correo ya registrado: respondemos igual que en el caso bueno y, si
      // aún no estaba verificado, reenviamos el enlace.
      if (!existente.verified) {
        try {
          const t = await crearToken(env, existente.id, "verify", VERIFY_HOURS);
          await enviarVerificacion(env, {
            to: existente.email,
            username: existente.username,
            enlace: `${baseUrl(request)}/api/auth/verify?token=${t}`,
          });
        } catch { /* silencio: no revelamos nada */ }
      }
      return json({ ok: true, mensaje: "revisa-el-correo" });
    }

    const id = crypto.randomUUID();
    const pass_hash = await hashDeServidor(env, dk, salt);
    const iteraciones = Number(cuerpo.iterations) || KDF_ITERATIONS;

    await env.DB.prepare(
      "INSERT INTO users (id, username, username_lc, email, email_lc, salt, pass_hash, " +
      "kdf_iterations, verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)"
    ).bind(id, username, username_lc, email, email_lc, salt, pass_hash, iteraciones, ahora()).run();

    try {
      const t = await crearToken(env, id, "verify", VERIFY_HOURS);
      await enviarVerificacion(env, {
        to: email,
        username,
        enlace: `${baseUrl(request)}/api/auth/verify?token=${t}`,
      });
    } catch (e) {
      // La cuenta existe pero nadie puede confirmarla: mejor deshacerla que
      // dejar el nombre de usuario bloqueado para siempre.
      await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
      return json({ error: "No he podido enviar el correo de confirmación.", detail: String(e).slice(0, 200) }, 502);
    }

    return json({ ok: true, mensaje: "revisa-el-correo" });
  }

  // ── confirmación del correo (se abre desde el enlace) ──────────────────────
  if (ruta === "verify" && request.method === "GET") {
    const t = await consumirToken(env, url.searchParams.get("token"), "verify");
    const userId = t?.userId;
    if (!userId) {
      return Response.redirect(`${baseUrl(request)}/?aviso=enlace-caducado`, 302);
    }
    await env.DB.prepare("UPDATE users SET verified = 1 WHERE id = ?").bind(userId).run();
    return Response.redirect(`${baseUrl(request)}/?aviso=cuenta-confirmada`, 302);
  }

  // ── inicio de sesión ───────────────────────────────────────────────────────
  if (ruta === "login" && request.method === "POST") {
    const login = String(cuerpo.login || "").trim().toLowerCase();
    const dk = String(cuerpo.dk || "");
    if (!login || !RE_DK.test(dk)) return json({ error: "Faltan datos." }, 400);

    if (!(await permitido(env, `login:${login}`, 10, 900)) ||
        !(await permitido(env, `loginip:${ip}`, 30, 900))) {
      return json({ error: "Demasiados intentos. Espera un cuarto de hora." }, 429);
    }

    const u = await env.DB.prepare(
      "SELECT id, username, email, salt, pass_hash, verified FROM users " +
      "WHERE username_lc = ? OR email_lc = ?"
    ).bind(login, login).first();

    // Mismo mensaje tanto si el usuario no existe como si la contraseña falla.
    const generico = { error: "Usuario o contraseña incorrectos." };
    if (!u) {
      await hashDeServidor(env, "0".repeat(64), "0".repeat(32)); // mismo coste
      return json(generico, 401);
    }

    const calculado = await hashDeServidor(env, dk, u.salt);
    if (!igual(calculado, u.pass_hash)) return json(generico, 401);

    if (!u.verified) {
      return json({ error: "Tienes que confirmar tu correo antes de entrar.", codigo: "sin-verificar" }, 403);
    }

    await limpiarIntentos(env, `login:${login}`);
    await env.DB.prepare("UPDATE users SET last_login = ? WHERE id = ?").bind(ahora(), u.id).run();
    const token = await crearSesion(env, u.id);

    return json(
      { ok: true, usuario: { id: u.id, username: u.username, email: u.email } },
      200,
      { "Set-Cookie": cabeceraCookie(token, SESSION_DAYS * 86400, request) }
    );
  }

  // ── cerrar sesión ──────────────────────────────────────────────────────────
  if (ruta === "logout" && request.method === "POST") {
    const token = leerCookie(request);
    if (token) {
      await env.DB.prepare("DELETE FROM sessions WHERE hash = ?")
        .bind(await sha256hex(token)).run();
    }
    return json({ ok: true }, 200, { "Set-Cookie": cabeceraCookie("", 0, request) });
  }

  // ── he olvidado mi contraseña ──────────────────────────────────────────────
  if (ruta === "forgot" && request.method === "POST") {
    const email_lc = String(cuerpo.email || "").trim().toLowerCase();
    // Siempre la misma respuesta: si dijéramos "ese correo no existe",
    // cualquiera podría averiguar quién tiene cuenta.
    const respuesta = json({ ok: true, mensaje: "si-existe-lo-recibes" });

    if (!RE_MAIL.test(email_lc)) return respuesta;
    if (!(await permitido(env, `forgot:${email_lc}`, 5, 3600))) return respuesta;

    const u = await env.DB.prepare(
      "SELECT id, username, email, verified FROM users WHERE email_lc = ?"
    ).bind(email_lc).first();
    if (!u || !u.verified) return respuesta;

    try {
      const t = await crearToken(env, u.id, "reset", RESET_HOURS);
      await enviarRestablecimiento(env, {
        to: u.email,
        username: u.username,
        enlace: `${baseUrl(request)}/?reset=${t}`,
      });
    } catch { /* silencio */ }

    return respuesta;
  }

  // ── comprobar un enlace de restablecimiento antes de pedir la contraseña ───
  if (ruta === "reset-info" && request.method === "POST") {
    const token = String(cuerpo.token || "");
    if (!/^[0-9a-f]{64}$/.test(token)) return json({ error: "Enlace no válido." }, 400);
    const fila = await env.DB.prepare(
      "SELECT u.username FROM tokens t JOIN users u ON u.id = t.user_id " +
      "WHERE t.hash = ? AND t.kind = 'reset' AND t.expires_at > ?"
    ).bind(await sha256hex(token), ahora()).first();
    if (!fila) return json({ error: "Ese enlace ya no vale. Pide otro." }, 400);
    return json({ username: fila.username, iterations: KDF_ITERATIONS });
  }

  // ── guardar la contraseña nueva ────────────────────────────────────────────
  if (ruta === "reset" && request.method === "POST") {
    const salt = String(cuerpo.salt || "");
    const dk = String(cuerpo.dk || "");
    if (!RE_SAL.test(salt) || !RE_DK.test(dk)) {
      return json({ error: "La contraseña no se ha preparado bien en el navegador. Recarga la página." }, 400);
    }
    const t = await consumirToken(env, cuerpo.token, "reset");
    const userId = t?.userId;
    if (!userId) return json({ error: "Ese enlace ya no vale. Pide otro." }, 400);

    const pass_hash = await hashDeServidor(env, dk, salt);
    await env.DB.prepare(
      "UPDATE users SET salt = ?, pass_hash = ?, kdf_iterations = ?, verified = 1 WHERE id = ?"
    ).bind(salt, pass_hash, Number(cuerpo.iterations) || KDF_ITERATIONS, userId).run();

    // Cambiar la contraseña echa a todas las sesiones abiertas. Si alguien te
    // había entrado en la cuenta, con esto se queda fuera.
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();

    return json({ ok: true });
  }

  return json({ error: "Ruta de autenticación no encontrada." }, 404);
}

export const AUTH_CONFIG = { KDF_ITERATIONS, MIN_PASS, DIAS_CAMBIO_USUARIO, IDIOMAS_VALIDOS };
