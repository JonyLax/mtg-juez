#!/usr/bin/env python3
"""
Construye el índice de nombres de carta traducidos.

Scryfall no sabe buscar por nombre traducido: su operador `name:` compara
siempre contra el nombre inglés, y `lang:` solo elige en qué idioma te devuelve
la carta. Así que nos hacemos el diccionario nosotros.

En vez de descargarnos el volcado completo (más de 2 GB), paginamos la búsqueda
`lang:es`, que devuelve 175 cartas por página. Unas 200 peticiones por idioma.

Uso:
    python3 tools/build_cards.py                 # español
    python3 tools/build_cards.py es pt fr        # varios idiomas

Salida: cards.sql, listo para cargar en D1.
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request

UA = "mtg-juez-builder/1.0 (indice privado de nombres de carta)"
API = "https://api.scryfall.com/cards/search"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cards.sql")

# Cuántas filas por sentencia INSERT. D1 se atraganta con sentencias enormes.
LOTE = 400


def pedir(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    for intento in range(4):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                return json.loads(r.read())
        except Exception as e:
            if intento == 3:
                raise
            print(f"    reintento {intento + 1} tras {e}", file=sys.stderr)
            time.sleep(2 * (intento + 1))


def nombres_de(lang):
    """Devuelve {nombre_impreso: nombre_ingles} para un idioma."""
    salida = {}
    q = urllib.parse.quote(f"lang:{lang}")
    url = f"{API}?q={q}&unique=prints&order=name"
    pagina = 0

    while url:
        pagina += 1
        datos = pedir(url)
        for c in datos.get("data", []):
            ingles = c.get("name")
            impreso = c.get("printed_name")
            # Las cartas de dos caras traen el nombre en cada cara
            if not impreso and c.get("card_faces"):
                trozos = [f.get("printed_name") for f in c["card_faces"]]
                if all(trozos):
                    impreso = " // ".join(trozos)
            if not ingles or not impreso:
                continue
            if impreso.strip().lower() == ingles.strip().lower():
                continue  # no aporta nada
            salida.setdefault(impreso.strip(), ingles.strip())

        url = datos.get("next_page") if datos.get("has_more") else None
        if pagina % 20 == 0:
            print(f"    página {pagina}, {len(salida)} nombres únicos")
        time.sleep(0.12)  # Scryfall pide no pasar de 10 peticiones por segundo

    return salida


def escapar(s):
    return s.replace("'", "''")


def main():
    idiomas = [a.lower() for a in sys.argv[1:]] or ["es"]
    filas = []

    for lang in idiomas:
        print(f"Idioma {lang}...")
        try:
            nombres = nombres_de(lang)
        except Exception as e:
            raise SystemExit(f"No he podido leer los nombres en {lang}: {e}")
        print(f"  {len(nombres)} nombres traducidos")
        if len(nombres) < 500:
            raise SystemExit(
                f"Solo {len(nombres)} nombres en {lang}. Esperaba miles: algo ha fallado."
            )
        for impreso, ingles in nombres.items():
            filas.append((impreso.lower(), lang, impreso, ingles))

    with open(OUT, "w", encoding="utf-8") as f:
        # Se reconstruye entero en cada ejecución: así desaparecen los nombres
        # de cartas que Scryfall haya corregido.
        f.write("DELETE FROM card_names;\n")
        for i in range(0, len(filas), LOTE):
            trozo = filas[i:i + LOTE]
            valores = ",".join(
                f"('{escapar(a)}','{escapar(b)}','{escapar(c)}','{escapar(d)}')"
                for a, b, c, d in trozo
            )
            f.write(
                "INSERT OR REPLACE INTO card_names (printed_lc, lang, printed, english) "
                f"VALUES {valores};\n"
            )

    tam = os.path.getsize(OUT) / 1024 / 1024
    print(f"\n{len(filas)} filas en {OUT} ({tam:.1f} MB)")
    print("Cárgalo con: wrangler d1 execute juez --remote --file=cards.sql --yes")


if __name__ == "__main__":
    main()
