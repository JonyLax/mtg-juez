#!/usr/bin/env python3
"""
Genera la web comercial en todos los idiomas a partir de una plantilla.

Un solo HTML y un fichero de textos. Anadir un idioma es copiar el bloque "en"
de site/strings.json, traducirlo, y anadir el codigo a IDIOMAS en src/index.js.

Uso:  python3 tools/build_site.py
Salida: public/es/index.html, public/es/precios.html, public/en/..., etc.
"""

import json
import os
import re
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(RAIZ, "site")
OUT = os.path.join(RAIZ, "public")

PLANES = """<div class="planes">
        <div class="plan" data-aparece data-orden="0">
          <h3>{gratis_t}</h3>
          <div class="precio">{gratis_p}</div>
          <p>{gratis_d}</p>
          <ul><li>{gratis_1}</li><li>{gratis_2}</li><li>{gratis_3}</li><li>{gratis_4}</li></ul>
          <a class="btn" href="https://chat.mtg-juez.com/" data-entrar="{abrir}">{cta_gratis}</a>
        </div>
        <div class="plan destacado" data-aparece data-orden="1">
          <h3>{pro_t}</h3>
          <div class="precio">{pro_p}</div>
          <p>{pro_d}</p>
          <ul><li>{pro_1}</li><li>{pro_2}</li><li>{pro_3}</li><li>{pro_4}</li></ul>
          <a class="btn hueco" href="mailto:hola@mtg-juez.com">{cta_pro}</a>
        </div>
        <div class="plan" data-aparece data-orden="2">
          <h3>{tienda_t}</h3>
          <div class="precio">{tienda_p}</div>
          <p>{tienda_d}</p>
          <ul><li>{tienda_1}</li><li>{tienda_2}</li><li>{tienda_3}</li><li>{tienda_4}</li></ul>
          <a class="btn hueco" href="mailto:hola@mtg-juez.com">{cta_tienda}</a>
        </div>
      </div>"""


def render(plantilla, textos):
    def sub(m):
        clave = m.group(1)
        if clave not in textos:
            raise SystemExit(f"Falta la clave '{clave}' en los textos de {textos.get('lang')}")
        return textos[clave]
    return re.sub(r"\{\{(\w+)\}\}", sub, plantilla)


def cuerpo_legal(doc):
    """Convierte las secciones del JSON en HTML."""
    trozos = []
    for sec in doc["secciones"]:
        trozos.append(f"<h2>{sec['h']}</h2>")
        for parrafo in sec["p"]:
            # Los huecos por rellenar se marcan en color, para que salten a la
            # vista si se publica la página sin completarlos.
            texto = re.sub(r"\[([A-ZÁÉÍÓÚÑ ]+)\]", r'<span class="rellenar">[\1]</span>', parrafo)
            trozos.append(f"<p>{texto}</p>")
    return f'<div class="legal-txt">{"".join(trozos)}</div>'


def main():
    with open(os.path.join(SITE, "strings.json"), encoding="utf-8") as f:
        todos = json.load(f)
    with open(os.path.join(SITE, "legal.json"), encoding="utf-8") as f:
        legales = json.load(f)
    idiomas = [k for k in todos if not k.startswith("_")]

    landing = open(os.path.join(SITE, "landing.html"), encoding="utf-8").read()
    precios = open(os.path.join(SITE, "precios.html"), encoding="utf-8").read()
    legal = open(os.path.join(SITE, "legal.html"), encoding="utf-8").read()

    # Todos los idiomas deben tener las mismas claves, o alguna pagina saldria a medias
    base = set(todos[idiomas[0]])
    for lang in idiomas:
        faltan = base - set(todos[lang])
        if faltan:
            raise SystemExit(f"A '{lang}' le faltan estas claves: {sorted(faltan)}")

    hechos = []
    for lang in idiomas:
        t = dict(todos[lang])

        # Enlaces entre idiomas, para buscadores y para el pie
        t["alternates"] = "\n".join(
            f'<link rel="alternate" hreflang="{o}" href="https://mtg-juez.com/{o}/">'
            for o in idiomas
        ) + '\n<link rel="alternate" hreflang="x-default" href="https://mtg-juez.com/en/">'
        t["selector_idioma"] = "".join(
            f'<a href="/{o}/"{" aria-current=\"true\"" if o == lang else ""}>'
            f'{todos[o]["nombre_idioma"]}</a>'
            for o in idiomas
        )
        t["planes"] = PLANES.format(
            gratis_t=t["precios_gratis_t"], gratis_p=t["precios_gratis_p"],
            gratis_d=t["precios_gratis_d"], gratis_1=t["precios_gratis_1"],
            gratis_2=t["precios_gratis_2"], gratis_3=t["precios_gratis_3"],
            gratis_4=t["precios_gratis_4"],
            pro_t=t["precios_pro_t"], pro_p=t["precios_pro_p"], pro_d=t["precios_pro_d"],
            pro_1=t["precios_pro_1"], pro_2=t["precios_pro_2"],
            pro_3=t["precios_pro_3"], pro_4=t["precios_pro_4"],
            tienda_t=t["precios_tienda_t"], tienda_p=t["precios_tienda_p"],
            tienda_d=t["precios_tienda_d"], tienda_1=t["precios_tienda_1"],
            tienda_2=t["precios_tienda_2"], tienda_3=t["precios_tienda_3"],
            tienda_4=t["precios_tienda_4"],
            cta_gratis=t["cta_gratis"], cta_pro=t["cta_pro"],
            cta_tienda=t["cta_tienda"], abrir=t["nav_abrir"],
        )

        carpeta = os.path.join(OUT, lang)
        os.makedirs(carpeta, exist_ok=True)

        # Las legales solo existen en castellano: dos traducciones de un mismo
        # contrato que digan cosas distintas es un problema, no una mejora.
        for clave, ruta in (("privacidad", "privacidad"), ("terminos", "terminos")):
            doc = legales[clave]
            t2 = dict(t)
            t2["legal_titulo"] = doc["titulo"]
            t2["legal_actualizado"] = doc["actualizado"]
            t2["legal_intro"] = doc["intro"]
            t2["legal_cuerpo"] = cuerpo_legal(doc)
            t2["legal_ruta"] = ruta
            aviso = legales["aviso_otro_idioma"].get(lang)
            t2["legal_aviso"] = f'<div class="aviso-idioma">{aviso}</div>' if aviso else ""
            with open(os.path.join(carpeta, f"{ruta}.html"), "w", encoding="utf-8") as f:
                f.write(render(legal, t2))
            hechos.append(os.path.join(carpeta, f"{ruta}.html"))

        for nombre, plantilla in (("index.html", landing), ("precios.html", precios)):
            ruta = os.path.join(carpeta, nombre)
            with open(ruta, "w", encoding="utf-8") as f:
                f.write(render(plantilla, t))
            hechos.append(ruta)

    # Mapa del sitio, para los buscadores
    urls = []
    for lang in idiomas:
        for ruta in ("", "precios", "privacidad", "terminos"):
            urls.append(f"  <url><loc>https://mtg-juez.com/{lang}/{ruta}</loc></url>")
    with open(os.path.join(OUT, "sitemap.xml"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="UTF-8"?>\n'
                '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
                + "\n".join(urls) + "\n</urlset>\n")
    with open(os.path.join(OUT, "robots.txt"), "w", encoding="utf-8") as f:
        f.write("User-agent: *\nAllow: /\nSitemap: https://mtg-juez.com/sitemap.xml\n")

    print(f"Idiomas: {', '.join(idiomas)}")
    for h in hechos:
        print(f"  {os.path.relpath(h, RAIZ)}  ({os.path.getsize(h) / 1024:.1f} KB)")
    print("  public/sitemap.xml, public/robots.txt")


if __name__ == "__main__":
    main()
