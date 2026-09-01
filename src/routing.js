// Enrutado del sitio.
//
//   chat.mtg-juez.com/…   -> la aplicación (public/app.html)
//   mtg-juez.com/         -> redirección a /es/, /en/… según el navegador
//   mtg-juez.com/es/…     -> web comercial en ese idioma
//
// El idioma se decide una vez y se recuerda en una cookie, para que quien lo
// cambie a mano no vuelva a ser redirigido. Es lo que hacen las tiendas
// grandes: entras en amazon.com y acabas en /es/ sin pedir nada.

// Añadir un idioma: tradúcelo en site/strings.json y añádelo aquí.
export const IDIOMAS_WEB = ["es", "en", "ca"];
const POR_DEFECTO = "en";
const COOKIE_IDIOMA = "juez_lang";

/** Rutas que la web comercial sirve en cada idioma. */
const PAGINAS = { "": "index.html", precios: "precios.html" };

export function esSubdominioChat(hostname) {
  return hostname.startsWith("chat.");
}

/**
 * Elige idioma mirando, por este orden: la cookie, el Accept-Language del
 * navegador y, si nada encaja, el idioma por defecto.
 */
export function elegirIdioma(request) {
  const cookies = request.headers.get("Cookie") || "";
  const guardado = cookies.match(new RegExp(`${COOKIE_IDIOMA}=([a-z-]+)`));
  if (guardado && IDIOMAS_WEB.includes(guardado[1])) return guardado[1];

  // "es-ES,es;q=0.9,en;q=0.8" -> [["es-es",1],["es",0.9],["en",0.8]]
  const cabecera = request.headers.get("Accept-Language") || "";
  const preferencias = cabecera
    .split(",")
    .map((trozo) => {
      const [etiqueta, ...params] = trozo.trim().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      return [etiqueta.toLowerCase(), q ? parseFloat(q.split("=")[1]) || 0 : 1];
    })
    .filter(([etiqueta]) => etiqueta)
    .sort((a, b) => b[1] - a[1]);

  for (const [etiqueta] of preferencias) {
    if (IDIOMAS_WEB.includes(etiqueta)) return etiqueta;
    const base = etiqueta.split("-")[0]; // es-ES -> es
    if (IDIOMAS_WEB.includes(base)) return base;
  }
  return POR_DEFECTO;
}

function cookieIdioma(lang) {
  return `${COOKIE_IDIOMA}=${lang}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

/**
 * Devuelve la respuesta de la web comercial, o null si la ruta no es suya y
 * debe seguir su camino.
 */
export async function servirWeb(request, env, url) {
  const partes = url.pathname.split("/").filter(Boolean);

  // Raíz: mandamos al idioma que toque
  if (partes.length === 0) {
    const lang = elegirIdioma(request);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/${lang}/`,
        "Set-Cookie": cookieIdioma(lang),
        // Sin esto, una CDN podría guardar la redirección de un idioma y
        // servírsela a todo el mundo.
        Vary: "Accept-Language, Cookie",
        "Cache-Control": "no-store",
      },
    });
  }

  const [lang, ...resto] = partes;
  if (!IDIOMAS_WEB.includes(lang)) return null; // /favicon.png, /site.css, /api/…

  const pagina = PAGINAS[resto.join("/")];
  if (!pagina) return null; // deja que responda el 404 de los assets

  // Cloudflare puede servir una carpeta con index.html tanto en "/es/" como en
  // "/es/index.html", y según la configuración una de las dos redirige a la
  // otra. Probamos las dos antes de darnos por vencidos.
  const candidatas = [`/${lang}/${pagina}`, `/${lang}/`];
  let activo = null;
  for (const ruta of candidatas) {
    const r = await env.ASSETS.fetch(new URL(ruta, url.origin));
    if (r.status === 200) { activo = r; break; }
  }

  if (!activo) {
    // Sin esto, un fallo de generación aparece como un 404 pelado y no hay
    // forma de saber si falta el fichero o si el enrutado está mal.
    return new Response(
      `No encuentro la página "${lang}/${pagina}".\n\n` +
      "La web se genera en cada despliegue con tools/build_site.py. Si ves esto:\n" +
      "  1. Mira en el log del despliegue el paso 'Generar la web comercial'.\n" +
      "  2. Comprueba que el idioma esté en site/strings.json y en IDIOMAS_WEB.\n" +
      "  3. Comprueba en /api/health que la versión desplegada es la que esperas.\n",
      { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } }
    );
  }

  const respuesta = new Response(activo.body, activo);
  respuesta.headers.set("Set-Cookie", cookieIdioma(lang));
  respuesta.headers.set("Content-Language", lang);
  return respuesta;
}
