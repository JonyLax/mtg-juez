#!/usr/bin/env python3
"""
Descarga las Comprehensive Rules de Magic y las trocea a JSON.

Uso:
    python tools/build_rules.py
    python tools/build_rules.py --url https://media.wizards.com/2026/downloads/MagicCompRules%2020260807.txt
    python tools/build_rules.py --file MagicCompRules.txt

Salida: worker/data/cr.json
Solo usa la biblioteca estandar, no hace falta instalar nada.
"""

import argparse
import datetime
import json
import os
import re
import sys
import urllib.request

RULES_PAGE = "https://magic.wizards.com/en/rules"
OUT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data", "cr.json",
)

UA = "mtg-juez-builder/1.0 (proyecto privado de reglas)"

# 100.1.  -> regla        100.1a -> subregla        100. -> cabecera de seccion
RE_RULE = re.compile(r"^(\d{3}\.\d+[a-z]?)\.?\s+(\S.*)$")
RE_SECTION = re.compile(r"^(\d{3})\.\s+(\S.*)$")
RE_CHAPTER = re.compile(r"^(\d)\.\s+(\S.*)$")
RE_EFFECTIVE = re.compile(r"effective as of ([A-Za-z]+ \d{1,2}, \d{4})")


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def find_txt_url():
    """Busca el enlace al .txt en la pagina oficial de reglas."""
    try:
        html = fetch(RULES_PAGE).decode("utf-8", "replace")
    except Exception as e:
        raise SystemExit(
            f"No he podido leer {RULES_PAGE} ({e}).\n"
            "Pasa el enlace a mano con --url o descarga el .txt y usa --file."
        )
    hits = re.findall(
        r"https://media\.wizards\.com/\d{4}/downloads/[^\"'\s<>]+\.txt", html
    )
    if not hits:
        raise SystemExit(
            "La pagina de reglas no expone el .txt en el HTML (puede cargarlo por JS).\n"
            "Abre https://magic.wizards.com/en/rules, copia el enlace TXT y usa --url."
        )
    # El mas reciente por fecha en el nombre del fichero
    return sorted(set(hits))[-1]


def decode(raw):
    for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "replace")


def clean_lines(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    # Wizards usa comillas y guiones tipograficos; los dejamos pero normalizamos NBSP
    text = text.replace("\u00a0", " ").replace("\u2019", "'").replace("\u201c", '"').replace("\u201d", '"')
    return [ln.rstrip() for ln in text.split("\n")]


def split_body_and_glossary(lines):
    """Devuelve (indice_inicio_cuerpo, indice_glosario, indice_creditos)."""
    first_rule = None
    for i, ln in enumerate(lines):
        if re.match(r"^100\.1\.\s", ln.strip()):
            first_rule = i
            break
    if first_rule is None:
        raise SystemExit("No encuentro la regla 100.1 en el fichero. Formato inesperado.")

    # Retrocede hasta la cabecera de capitulo que precede al cuerpo
    start = first_rule
    for j in range(first_rule, max(first_rule - 12, -1), -1):
        if RE_CHAPTER.match(lines[j].strip()):
            start = j
            break

    glossary = None
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].strip() == "Glossary":
            glossary = i
            break

    credits = len(lines)
    if glossary is not None:
        for i in range(len(lines) - 1, glossary, -1):
            if lines[i].strip() == "Credits":
                credits = i
                break

    return start, glossary, credits


def parse_rules(lines, start, end):
    rules = []
    chapter = chapter_title = ""
    section = section_title = ""
    current = None

    for raw in lines[start:end]:
        ln = raw.strip()
        if not ln:
            continue

        m = RE_CHAPTER.match(ln)
        if m and len(m.group(1)) == 1:
            chapter, chapter_title = m.group(1), m.group(2).strip()
            current = None
            continue

        m = RE_SECTION.match(ln)
        if m:
            section, section_title = m.group(1), m.group(2).strip()
            current = None
            continue

        m = RE_RULE.match(ln)
        if m:
            rid, body = m.group(1), m.group(2).strip()
            parent = rid[:-1] if rid[-1].isalpha() else None
            current = {
                "id": rid,
                "parent": parent,
                "section": section or rid.split(".")[0],
                "section_title": section_title,
                "chapter": chapter,
                "chapter_title": chapter_title,
                "text": body,
            }
            rules.append(current)
            continue

        # Continuacion de la regla anterior (tablas, ejemplos, listas)
        if current is not None:
            current["text"] += " " + ln

    return rules


def parse_glossary(lines, gl_start, gl_end):
    entries = []
    block = []
    for raw in lines[gl_start + 1:gl_end]:
        ln = raw.strip()
        if not ln:
            if block:
                term, *rest = block
                if rest:
                    entries.append({"term": term, "text": " ".join(rest)})
                block = []
            continue
        block.append(ln)
    if block:
        term, *rest = block
        if rest:
            entries.append({"term": term, "text": " ".join(rest)})
    return entries


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", help="Enlace directo al .txt de las Comprehensive Rules")
    ap.add_argument("--file", help="Fichero .txt ya descargado")
    ap.add_argument("--out", default=OUT_PATH)
    args = ap.parse_args()

    if args.file:
        source = os.path.abspath(args.file)
        with open(args.file, "rb") as f:
            raw = f.read()
    else:
        source = args.url or find_txt_url()
        print(f"Descargando {source}")
        raw = fetch(source)

    lines = clean_lines(decode(raw))

    effective = ""
    for ln in lines[:60]:
        m = RE_EFFECTIVE.search(ln)
        if m:
            effective = m.group(1)
            break

    start, gl_start, credits = split_body_and_glossary(lines)
    body_end = gl_start if gl_start is not None else len(lines)

    rules = parse_rules(lines, start, body_end)
    glossary = parse_glossary(lines, gl_start, credits) if gl_start is not None else []

    if len(rules) < 1500:
        raise SystemExit(f"Solo he sacado {len(rules)} reglas. Algo ha ido mal en el parseo.")

    payload = {
        "meta": {
            "effective": effective,
            "source": source,
            "built_at": datetime.datetime.now(datetime.timezone.utc)
            .replace(microsecond=0)
            .isoformat(),
            "rule_count": len(rules),
            "glossary_count": len(glossary),
        },
        "rules": rules,
        "glossary": glossary,
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    size = os.path.getsize(args.out) / 1024 / 1024
    print(f"Vigentes desde: {effective or 'desconocido'}")
    print(f"Reglas:   {len(rules)}")
    print(f"Glosario: {len(glossary)}")
    print(f"Escrito:  {args.out} ({size:.2f} MB)")

    # Chequeos rapidos de sanidad
    ids = {r["id"] for r in rules}
    for probe in ("100.1", "104.3b", "509.1a", "603.3", "613.2", "704.5a", "903.4"):
        if probe not in ids:
            print(f"  aviso: no encuentro la regla {probe}", file=sys.stderr)


if __name__ == "__main__":
    main()
