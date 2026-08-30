#!/usr/bin/env python3
"""
Ejecuta un fichero .sql contra la base de datos D1.

Por qué no usamos `wrangler d1 execute --file`: ese comando no ejecuta el SQL,
lo sube por el endpoint de *importación* de Cloudflare, que exige permisos
distintos de los de D1 y falla con "Authentication error [code: 10000]" aunque
el token tenga D1 · Edit. Aquí hablamos con el endpoint de consulta normal,
que funciona con ese permiso y ya está.

Uso:
    python3 tools/d1_exec.py schema.sql
    python3 tools/d1_exec.py migrate.sql --tolerar-errores

Lee de las variables de entorno CLOUDFLARE_ACCOUNT_ID y CLOUDFLARE_API_TOKEN,
y saca el identificador de la base de datos de wrangler.toml.
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOTE_BYTES = 40000  # tamaño máximo de cada petición


def id_base_datos():
    with open(os.path.join(RAIZ, "wrangler.toml"), encoding="utf-8") as f:
        m = re.search(r'database_id\s*=\s*"([^"]+)"', f.read())
    if not m or m.group(1).startswith("PEGA_AQUI"):
        raise SystemExit("Falta el database_id en wrangler.toml.")
    return m.group(1)


def sentencias(ruta):
    """Cada línea no vacía es una sentencia. Así los escribimos nosotros."""
    with open(ruta, encoding="utf-8") as f:
        for linea in f:
            s = linea.strip()
            if s and not s.startswith("--"):
                yield s


def lotes(items):
    actual, tam = [], 0
    for s in items:
        if actual and tam + len(s) > LOTE_BYTES:
            yield actual
            actual, tam = [], 0
        actual.append(s)
        tam += len(s) + 1
    if actual:
        yield actual


def ejecutar(cuenta, token, db, sql):
    url = f"https://api.cloudflare.com/client/v4/accounts/{cuenta}/d1/database/{db}/query"
    datos = json.dumps({"sql": sql}).encode()
    req = urllib.request.Request(
        url,
        data=datos,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            cuerpo = json.loads(r.read())
    except urllib.error.HTTPError as e:
        cuerpo = json.loads(e.read() or b"{}")
    except Exception as e:
        return False, str(e)

    if cuerpo.get("success"):
        return True, ""
    errores = cuerpo.get("errors") or []
    return False, "; ".join(str(x.get("message", x)) for x in errores) or "error desconocido"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fichero")
    ap.add_argument("--tolerar-errores", action="store_true",
                    help="sigue adelante si una sentencia falla (migraciones ya aplicadas)")
    args = ap.parse_args()

    cuenta = (os.environ.get("CLOUDFLARE_ACCOUNT_ID") or "").strip()
    token = (os.environ.get("CLOUDFLARE_API_TOKEN") or "").strip()
    if not cuenta or not token:
        raise SystemExit("Faltan CLOUDFLARE_ACCOUNT_ID o CLOUDFLARE_API_TOKEN.")

    db = id_base_datos()
    todas = list(sentencias(args.fichero))
    if not todas:
        raise SystemExit(f"{args.fichero} no tiene ninguna sentencia.")

    grupos = list(lotes(todas))
    print(f"{args.fichero}: {len(todas)} sentencias en {len(grupos)} peticiones")

    fallos = 0
    for i, grupo in enumerate(grupos, 1):
        ok, error = ejecutar(cuenta, token, db, "\n".join(grupo))
        if ok:
            if len(grupos) > 10 and i % 10 == 0:
                print(f"  {i}/{len(grupos)}")
            continue

        if args.tolerar_errores:
            print(f"  lote {i}: {error} (tolerado)")
            continue

        # Una sentencia del lote ha fallado: la repetimos una a una para poder
        # decir exactamente cuál, en vez de un error opaco sobre 400 líneas.
        print(f"  lote {i} ha fallado, lo desgloso...", file=sys.stderr)
        for s in grupo:
            ok2, error2 = ejecutar(cuenta, token, db, s)
            if not ok2:
                fallos += 1
                print(f"  ERROR: {error2}\n    en: {s[:120]}", file=sys.stderr)
        time.sleep(0.3)

    if fallos and not args.tolerar_errores:
        raise SystemExit(f"{fallos} sentencias han fallado.")
    print("Hecho.")


if __name__ == "__main__":
    main()
