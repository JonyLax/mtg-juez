// Límites de uso.
//
// Dos techos, porque protegen de cosas distintas:
//   - Por cuenta: que una sola persona no se coma la cuota del grupo.
//   - Global: que la suma de todos no agote la clave de Gemini. Este es el que
//     de verdad evita que un día bueno deje la herramienta muerta para todos.
//
// Se cuentan unidades, no mensajes: una consulta de reglas es una llamada al
// modelo y un mazo son dos, más varias a Scryfall.

export const COSTE = { reglas: 1, mazo: 3 };

export const PLANES = {
  free:    { nombre: "Gratis", diario: 25 },
  pro:     { nombre: "Pro", diario: 150 },
  tienda:  { nombre: "Tienda", diario: 500 },
};

// Techo de toda la instalación. Con la clave gratuita de Gemini conviene ser
// conservador; cuando pases a plan de pago, súbelo con la variable GLOBAL_DIARIO.
const GLOBAL_POR_DEFECTO = 400;

/** Fecha en horario español: el día debe cambiar de madrugada aquí, no en UTC. */
function hoy() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());
}

function limiteDe(usuario, env) {
  const plan = PLANES[usuario?.plan] || PLANES.free;
  const propio = Number(env?.[`LIMITE_${(usuario?.plan || "free").toUpperCase()}`]);
  return Number.isFinite(propio) && propio > 0 ? propio : plan.diario;
}

async function leer(env, clave, dia) {
  const f = await env.DB.prepare("SELECT unidades FROM consumo WHERE clave = ? AND dia = ?")
    .bind(clave, dia).first();
  return f?.unidades || 0;
}

async function sumar(env, clave, dia, unidades) {
  await env.DB.prepare(
    "INSERT INTO consumo (clave, dia, unidades) VALUES (?, ?, ?) " +
    "ON CONFLICT(clave) DO UPDATE SET " +
    "unidades = CASE WHEN consumo.dia = excluded.dia THEN consumo.unidades + excluded.unidades " +
    "                ELSE excluded.unidades END, " +
    "dia = excluded.dia"
  ).bind(clave, dia, unidades).run();
}

/**
 * Comprueba y descuenta. Devuelve {ok:false, motivo} si no hay saldo.
 * Se descuenta ANTES de llamar al modelo: si fallara despues, hemos gastado
 * una unidad de mas, que es preferible a que un error deje la puerta abierta.
 */
export async function consumir(env, usuario, tipo) {
  if (!env.DB) return { ok: true, sinControl: true };

  const coste = COSTE[tipo] || 1;
  const dia = hoy();
  const limite = limiteDe(usuario, env);
  const global = Number(env.GLOBAL_DIARIO) || GLOBAL_POR_DEFECTO;
  const clave = `u:${usuario?.id || "anon"}`;

  const [propio, total] = await Promise.all([
    leer(env, clave, dia),
    leer(env, "global", dia),
  ]);

  if (total + coste > global) {
    return {
      ok: false,
      motivo: "global",
      mensaje:
        "Hoy se ha agotado la cuota compartida de la herramienta. Vuelve mañana; " +
        "el contador se reinicia a medianoche.",
      restantes: 0,
      limite,
    };
  }

  if (propio + coste > limite) {
    const plan = PLANES[usuario?.plan] || PLANES.free;
    return {
      ok: false,
      motivo: "personal",
      mensaje:
        `Has agotado tus ${limite} consultas diarias del plan ${plan.nombre}. ` +
        "El contador se reinicia a medianoche" +
        (usuario?.plan === "free" || !usuario?.plan
          ? ", y los planes de pago tienen bastante más margen."
          : "."),
      restantes: 0,
      limite,
    };
  }

  await Promise.all([
    sumar(env, clave, dia, coste),
    sumar(env, "global", dia, coste),
  ]);

  // Limpieza de dias viejos, de vez en cuando: sin esto la tabla crece sola.
  if (Math.random() < 0.02) {
    await env.DB.prepare("DELETE FROM consumo WHERE dia < ?").bind(dia).run().catch(() => {});
  }

  return { ok: true, restantes: Math.max(0, limite - propio - coste), limite, coste };
}

/** Saldo del día, sin descontar nada. Para pintarlo en la interfaz. */
export async function saldo(env, usuario) {
  if (!env.DB || !usuario) return null;
  const limite = limiteDe(usuario, env);
  const usadas = await leer(env, `u:${usuario.id}`, hoy());
  return {
    plan: usuario.plan || "free",
    plan_nombre: (PLANES[usuario.plan] || PLANES.free).nombre,
    limite,
    usadas,
    restantes: Math.max(0, limite - usadas),
  };
}
