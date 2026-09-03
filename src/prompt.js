export const FORMATS = {
  commander: {
    label: "Commander (EDH)",
    legality: "commander",
    notes:
      "Partida multijugador, normalmente 4 jugadores, 40 vidas, mazos de 100 cartas singleton. " +
      "Aplican la seccion 903 completa: identidad de color, zona de mando, impuesto de comandante " +
      "(2 genericos por cada vez previa que se haya lanzado desde la zona de mando) y dano de " +
      "comandante (21 de un mismo comandante elimina a un jugador). Cuando un comandante fuera a " +
      "ir al cementerio, exilio, mano o biblioteca, su propietario puede en su lugar mandarlo a la " +
      "zona de mando.",
  },
  duel: {
    label: "Constructed 1 contra 1",
    legality: null, // se decide con el formato concreto que elija el jugador
    notes:
      "Partida a dos jugadores, 20 vidas, mazo minimo de 60 cartas y banquillo de hasta 15. " +
      "Las reglas de juego son las basicas: lo unico que cambia entre Standard, Pioneer, Modern, " +
      "Legacy y Vintage es que cartas son legales, no como funcionan.",
  },
  limited: {
    label: "Limitado (draft o sellado)",
    legality: null,
    notes:
      "Mazo minimo de 40 cartas, todas las cartas no incluidas en el mazo forman parte del " +
      "banquillo, y se permiten tantas tierras basicas como haga falta. Se pueden usar tantas " +
      "copias de una carta como aparezcan en el producto abierto.",
  },
  "2hg": {
    label: "Gigante de dos cabezas",
    legality: null,
    notes:
      "Dos equipos de dos jugadores. Aplica la seccion 810: el equipo comparte un total de 30 " +
      "vidas, comparte turno, ambos companeros roban en su paso de robar salvo el equipo que " +
      "empieza, y el dano de veneno tambien es compartido (15 contadores). Los companeros pueden " +
      "verse las manos y hablar libremente.",
  },
  casual: {
    label: "Casual multijugador",
    legality: null,
    notes:
      "Partida de todos contra todos (seccion 806): rango de influencia ilimitado por defecto, " +
      "orden de turno en el sentido de las agujas del reloj, y cuando un jugador deja la partida " +
      "sus objetos permanentes abandonan el juego.",
  },
};

export const IDIOMAS = {
  es: "castellano",
  en: "English",
  pt: "português",
  fr: "français",
  de: "Deutsch",
  it: "italiano",
};

export function systemPrompt({ format, houseRules, legalityKey, crEffective, lang }) {
  const f = FORMATS[format] || FORMATS.duel;
  const idioma = IDIOMAS[lang] || IDIOMAS.es;

  return `Eres un juez de Magic: The Gathering. Resuelves dudas de reglas para un grupo de amigos que esta jugando ahora mismo, asi que respondes rapido y sin rodeos.

CONTEXTO DE LA PARTIDA
Formato: ${f.label}${legalityKey ? ` (legalidad: ${legalityKey})` : ""}
${f.notes}
${houseRules ? `\nAcuerdos de mesa que los jugadores han declarado (Rule 0). Tienen prioridad sobre lo que sea casual, nunca sobre las reglas del juego:\n${houseRules}` : ""}

Reglas vigentes desde: ${crEffective || "version actual"}

COMO TRABAJAS
1. Solo puedes apoyarte en las reglas y textos de carta que te paso en el bloque de contexto. No cites de memoria numeros de regla que no aparezcan ahi.
2. Cada afirmacion de reglas va acompanada de su numero entre corchetes, asi: [CR 603.3a]. Un solo numero por corchete: si necesitas citar dos, escribe [CR 304.2] [CR 608.2n], nunca [CR 304.2, CR 608.2n]. Si una respuesta no lleva ninguna cita, esta mal.
3. El texto oracle en ingles es el autoritativo. Si el jugador cita el texto impreso en castellano y difiere, avisale y usa el oracle.
4. Si te falta un dato para responder bien (que criatura entro antes, quien controla que, si ya se habia lanzado el comandante), NO adivines: devuelve tipo "clarificacion" con 2 a 4 opciones concretas y excluyentes.
5. Si las reglas que tienes delante no cubren el caso, dilo claramente y pon confianza "baja". Es mucho mejor que inventar.
6. Explica el porque, no solo el resultado. Cuando el orden importe (pila, capas, acciones basadas en el estado), enumera los pasos.
7. IDIOMA: escribes SIEMPRE en ${idioma}, sea cual sea el idioma de la pregunta. Segunda persona, tono de colega que sabe de esto. Sin florituras ni disculpas.
8. ORTOGRAFIA: escribes con la ortografia correcta del idioma, con sus tildes y signos (daño, más, resolución). Estas instrucciones van sin tildes por motivos tecnicos del sistema: NO imites esa carencia en tus respuestas.

CONFIANZA
- alta: las reglas del contexto responden el caso de forma directa.
- media: la respuesta se deduce de las reglas pero hay algun matiz.
- baja: las reglas del contexto no cubren bien el caso, o depende de informacion que no tienes.`;
}

export function buildContext({ rules, glossary, cards }) {
  const parts = [];

  if (cards?.length) {
    parts.push("=== CARTAS CONSULTADAS (datos oficiales de Scryfall) ===");
    for (const c of cards) {
      if (!c.found) {
        parts.push(`[${c.query}] NO ENCONTRADA en Scryfall. Avisa al jugador de que revise el nombre.`);
        continue;
      }
      const head = `${c.name}${c.printed_name && c.printed_name !== c.name ? ` (impresa en es: ${c.printed_name})` : ""}`;
      const stats = c.power ? ` [${c.power}/${c.toughness}]` : c.loyalty ? ` [lealtad ${c.loyalty}]` : "";
      parts.push(`--- ${head} ${c.mana_cost} — ${c.type_line}${stats}`);
      if (c.faces) {
        for (const face of c.faces) {
          parts.push(`  Cara "${face.name}" ${face.mana_cost} — ${face.type_line}`);
          parts.push(`  ${face.oracle_text}`);
        }
      } else {
        parts.push(c.oracle_text || "(sin texto de reglas)");
      }
      if (c.legality) parts.push(`Legalidad en el formato: ${c.legality}`);
      if (c.rulings?.length) {
        parts.push("Rulings oficiales:");
        for (const r of c.rulings) parts.push(`  - ${r}`);
      }
    }
    parts.push("");
  }

  if (glossary?.length) {
    parts.push("=== GLOSARIO ===");
    for (const g of glossary) parts.push(`${g.term}: ${g.text}`);
    parts.push("");
  }

  parts.push("=== REGLAS RECUPERADAS ===");
  for (const r of rules) parts.push(`${r.id} ${r.text}`);

  return parts.join("\n");
}

export const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    tipo: { type: "STRING", enum: ["respuesta", "clarificacion"] },
    texto: { type: "STRING" },
    reglas_citadas: { type: "ARRAY", items: { type: "STRING" } },
    opciones: { type: "ARRAY", items: { type: "STRING" } },
    confianza: { type: "STRING", enum: ["alta", "media", "baja"] },
    // Si la pregunta va de construir mazos, lo decimos para ofrecer el cambio
    // de modo. No cambiamos solos: una respuesta de mazo a una duda de reglas
    // seria correcta pero a otra pregunta.
    sugerir_modo_mazo: { type: "BOOLEAN" },
  },
  required: ["tipo", "texto", "reglas_citadas", "confianza"],
  propertyOrdering: ["tipo", "texto", "reglas_citadas", "opciones", "confianza", "sugerir_modo_mazo"],
};

// ─────────────────────────────────────────────────────────────────────────────
// MODO MAZO
//
// Dos vueltas. En la primera el modelo NO nombra cartas: traduce lo que pide el
// jugador a busquedas de Scryfall. En la segunda solo puede elegir de entre las
// cartas reales que esas busquedas han devuelto. Asi no puede inventarse una
// carta, ni saltarse la identidad de color, ni equivocarse con un precio.
// ─────────────────────────────────────────────────────────────────────────────

export function planPrompt({ lang }) {
  const idioma = IDIOMAS[lang] || IDIOMAS.es;
  return `Eres el planificador de un constructor de mazos de Magic. Tu unico trabajo es traducir lo que pide el jugador a busquedas de Scryfall. NO propones cartas: no tienes forma de saber su precio ni su legalidad, y si las nombras de memoria te equivocaras.

QUE TIENES QUE EXTRAER
- formato: commander, duel, limited, 2hg o casual.
- comandante: si lo nombra. Escribelo en INGLES si lo reconoces; si te lo dice en otro idioma, traducelo.
- bracket: de 1 a 5, si lo dice. Brackets 1 y 2 no admiten game changers, el 3 admite hasta tres, el 4 y el 5 no tienen limite.
- presupuesto_total y moneda: si da una cifra.
- cartas_mencionadas: cualquier carta que nombre, en INGLES.
- intencion: "construir" un mazo entero, "recomendar" cartas que encajen con algo, o "evaluar" si una carta concreta vale.

LAS BUSQUEDAS
Propon entre 4 y 8 busquedas que cubran lo que hace falta. NO pongas en ellas la identidad de color, la legalidad ni el precio: eso lo anade el sistema por su cuenta. Concentrate en el QUE.

Sintaxis util de Scryfall: t:dragon (tipo), o:"draw a card" (texto), c:r (color), mv<=3 (valor de mana), is:removal, is:boardwipe, o:"add {C}" (mana), kw:flying, f:commander.

Para un mazo entero cubre al menos: la tematica principal, aceleracion de mana, robo de cartas, remocion puntual, barridos, y tierras que fijen el color. Pide cuantas suficientes: un mazo de Commander son 100 cartas y uno de constructed 60 minimo, asi que con 10 resultados por busqueda no llega. Usa "cuantas" para pedir entre 12 y 20 en las busquedas principales.
Ejemplo para dragones: {"para":"Dragones baratos que aporten al plan","consulta":"t:dragon mv<=6"}, {"para":"Aceleracion de mana","consulta":"o:\\"add\\" (t:artifact or t:creature) mv<=3"}, etc.

SI FALTA INFORMACION
Si no sabes el formato, o pide un mazo sin decir comandante ni tematica, pon lo que falte en falta_info y deja busquedas vacio. Mas vale preguntar que construir a ciegas.

Escribe "entendido" en ${idioma}.`;
}

export const PLAN_SCHEMA = {
  type: "OBJECT",
  properties: {
    entendido: { type: "STRING" },
    formato: { type: "STRING" },
    comandante: { type: "STRING" },
    bracket: { type: "INTEGER" },
    presupuesto_total: { type: "NUMBER" },
    moneda: { type: "STRING", enum: ["eur", "usd"] },
    cartas_mencionadas: { type: "ARRAY", items: { type: "STRING" } },
    intencion: { type: "STRING", enum: ["construir", "recomendar", "evaluar"] },
    busquedas: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          para: { type: "STRING" },
          consulta: { type: "STRING" },
          cuantas: { type: "INTEGER" },
        },
        required: ["para", "consulta"],
      },
    },
    falta_info: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["entendido", "intencion", "busquedas"],
};

export function mazoPrompt({ lang, limites, intencion }) {
  const idioma = IDIOMAS[lang] || IDIOMAS.es;
  const b = BRACKETS_TEXTO[limites.bracket];
  const sim = limites.moneda === "usd" ? "USD" : "EUR";
  const r = REGLAS_MAZO[limites.formato] || REGLAS_MAZO.commander;

  return `Eres un constructor de mazos de Magic con criterio. Ya tienes delante las cartas reales que encajan con lo que ha pedido el jugador.

LO QUE HA PEDIDO
Formato: ${limites.formato || "commander"}
${limites.comandante ? `Comandante: ${limites.comandante} (identidad de color ${limites.identidad || "?"})` : "Sin comandante indicado."}
${limites.bracket ? `Bracket ${limites.bracket}${b ? ` (${b})` : ""}.` : "Sin bracket indicado."}
${limites.presupuesto ? `Presupuesto total: ${limites.presupuesto} ${sim}, contando la impresion mas barata de cada carta.` : "Sin presupuesto indicado."}

REGLAS QUE NO PUEDES SALTARTE
1. Solo existen las cartas de la lista que te paso. Si nombras una que no esta ahi, es un error grave: el jugador no podra comprarla o no sera legal.
2. EL PRESUPUESTO ES DEL MAZO ENTERO, no de cada carta. Un mazo bien construido tiene la mayoria de cartas baratas y dos o tres piezas caras que lo sostienen. Puedes gastar hasta un tercio del presupuesto en esas piezas clave si de verdad lo merecen; el resto tiene que salir barato para que cuadre. Ve sumando segun avanzas y, si te pasas, cambia cartas por alternativas mas baratas de la lista en vez de ignorarlo.
3. ${limites.bracket <= 2 ? "Este bracket no admite NINGUN game changer: no incluyas los marcados como tal." : limites.bracket === 3 ? "Este bracket admite como maximo TRES game changers. Cuentalos." : "Este bracket no limita los game changers."}
4. TAMANO Y CONSTRUCCION en ${limites.formato || "commander"}: ${r.cartas}; ${r.copias}${r.extra ? `; ${r.extra}` : ""}. Si construyes el mazo entero, cuenta las cartas y di cuantas tierras basicas completan el hueco en vez de listarlas una a una. Un mazo con menos cartas de las que exige el formato es ilegal y no le sirve al jugador.

COMO RESPONDES
- Explica primero el plan del mazo: que quiere hacer, como gana, que hace en los primeros turnos. Sin esto, una lista de cartas no le sirve de nada a nadie.
- Agrupa las cartas por funcion (motor principal, aceleracion, robo, interaccion, tierras) y di en una linea POR QUE esta cada una. El porque es lo que le ensena a construir, no la lista.
- Si un combo verificado de los que te paso se puede cerrar con una carta mas, dilo explicitamente.
- Al final, la lista completa para copiar y pegar, en formato "1 Nombre En Ingles", una por linea, con los nombres EXACTOS tal como aparecen en la lista de cartas disponibles.
- Si te faltan datos para hacerlo bien, devuelve tipo "clarificacion" con opciones concretas en vez de suponer.

IDIOMA: escribe en ${idioma}, con su ortografia correcta. Los nombres de carta van SIEMPRE en ingles, que es como se buscan y se compran.
Intencion detectada: ${intencion}.`;
}

// Tamano y construccion segun el formato. Meter esto a mano en el prompt era
// pedir un mazo ilegal: constructed son 60 minimo, no 40; las 40 son de limitado.
export const REGLAS_MAZO = {
  commander: {
    cartas: "exactamente 100 cartas contando el comandante",
    copias: "una sola copia de cada carta, salvo tierras basicas",
    extra: "todas dentro de la identidad de color del comandante",
  },
  duel: {
    cartas: "60 cartas como minimo, sin maximo",
    copias: "hasta 4 copias de cada carta, salvo tierras basicas",
    extra: "banquillo opcional de hasta 15 cartas",
  },
  limited: {
    cartas: "40 cartas como minimo",
    copias: "tantas copias como hayas abierto",
    extra: "las tierras basicas son ilimitadas y no cuentan como banquillo",
  },
  "2hg": {
    cartas: "60 cartas como minimo por jugador",
    copias: "hasta 4 copias de cada carta, salvo tierras basicas",
    extra: "el equipo comparte 30 vidas y turno",
  },
  casual: {
    cartas: "60 cartas como minimo",
    copias: "hasta 4 copias de cada carta, salvo tierras basicas",
    extra: "",
  },
};

const BRACKETS_TEXTO = {
  1: "Exhibition, tematico",
  2: "Core, nivel precon",
  3: "Upgraded, precon mejorado",
  4: "Optimized",
  5: "cEDH competitivo",
};

export const MAZO_SCHEMA = {
  type: "OBJECT",
  properties: {
    tipo: { type: "STRING", enum: ["mazo", "sugerencias", "clarificacion"] },
    texto: { type: "STRING" },
    secciones: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          titulo: { type: "STRING" },
          cartas: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                nombre: { type: "STRING" },
                cuantas: { type: "INTEGER" },
                porque: { type: "STRING" },
              },
              required: ["nombre", "porque"],
            },
          },
        },
        required: ["titulo", "cartas"],
      },
    },
    tierras_basicas: { type: "INTEGER" },
    lista: { type: "ARRAY", items: { type: "STRING" } },
    opciones: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["tipo", "texto"],
};
