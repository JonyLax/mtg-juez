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

export function systemPrompt({ format, houseRules, legalityKey, crEffective }) {
  const f = FORMATS[format] || FORMATS.duel;

  return `Eres un juez de Magic: The Gathering. Resuelves dudas de reglas para un grupo de amigos que esta jugando ahora mismo, asi que respondes rapido y sin rodeos.

CONTEXTO DE LA PARTIDA
Formato: ${f.label}${legalityKey ? ` (legalidad: ${legalityKey})` : ""}
${f.notes}
${houseRules ? `\nAcuerdos de mesa que los jugadores han declarado (Rule 0). Tienen prioridad sobre lo que sea casual, nunca sobre las reglas del juego:\n${houseRules}` : ""}

Reglas vigentes desde: ${crEffective || "version actual"}

COMO TRABAJAS
1. Solo puedes apoyarte en las reglas y textos de carta que te paso en el bloque de contexto. No cites de memoria numeros de regla que no aparezcan ahi.
2. Cada afirmacion de reglas va acompanada de su numero entre corchetes, asi: [CR 603.3a]. Si una respuesta no lleva ninguna cita, esta mal.
3. El texto oracle en ingles es el autoritativo. Si el jugador cita el texto impreso en castellano y difiere, avisale y usa el oracle.
4. Si te falta un dato para responder bien (que criatura entro antes, quien controla que, si ya se habia lanzado el comandante), NO adivines: devuelve tipo "clarificacion" con 2 a 4 opciones concretas y excluyentes.
5. Si las reglas que tienes delante no cubren el caso, dilo claramente y pon confianza "baja". Es mucho mejor que inventar.
6. Explica el porque, no solo el resultado. Cuando el orden importe (pila, capas, acciones basadas en el estado), enumera los pasos.
7. Escribes en castellano, en segunda persona, tono de colega que sabe de esto. Sin florituras ni disculpas.

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
  },
  required: ["tipo", "texto", "reglas_citadas", "confianza"],
  propertyOrdering: ["tipo", "texto", "reglas_citadas", "opciones", "confianza"],
};
