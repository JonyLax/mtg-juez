# Juez — bot de reglas de Magic para tu grupo

Un chat que resuelve dudas de reglas apoyándose en las Comprehensive Rules oficiales
y en los datos de carta de Scryfall. Cada afirmación va con su número de regla, y el
número se puede pulsar para leer el texto literal.

**No hace falta consola.** Todo el montaje se hace desde el navegador: GitHub para el
código, GitHub Actions para construir y desplegar, y el panel de Cloudflare para los
secretos. Coste: 0 €.

```
wrangler.toml              configuración del Worker
schema.sql                 tablas de usuarios para D1
public/index.html          la web
src/index.js               rutas y llamada a Gemini
src/retrieval.js           índice BM25 sobre las reglas
src/glossary.js            diccionario ES→EN de terminología
src/scryfall.js            cliente de Scryfall
src/prompt.js              prompt de sistema y contexto por formato
src/auth.js                registro, sesiones y contraseñas
src/mail.js                correos de confirmación y recuperación
data/cr.json               las reglas troceadas (lo genera el workflow)
tools/build_rules.py       descarga y trocea las Comprehensive Rules
.github/workflows/deploy.yml   lo hace todo
```

Un solo Worker sirve la web y la API. No hay proyecto de Pages, no hay CORS que
configurar y el frontend no tiene ninguna URL escrita a mano.

---

## Paso 1 — Subir el proyecto a GitHub

1. Entra en <https://github.com/new>, crea un repositorio **privado** llamado
   `mtg-juez`. Marca *Add a README file* para que no nazca vacío.
2. Descomprime el proyecto en tu ordenador.
3. En el repo, **Add file → Upload files**. Arrastra las carpetas `public`, `src`,
   `data`, `tools` y los ficheros `wrangler.toml`, `package.json` y `.gitignore`.
   Chrome conserva la estructura de carpetas al arrastrar. Dale a *Commit changes*.
4. El workflow va aparte, porque las carpetas que empiezan por punto no siempre se
   arrastran bien. Usa **Add file → Create new file** y escribe como nombre exactamente:

   ```
   .github/workflows/deploy.yml
   ```

   Pega dentro el contenido de ese fichero y confirma.

---

## Paso 2 — Clave de Gemini

Entra en <https://aistudio.google.com/apikey> con tu cuenta de Google y crea una API
key. No pide tarjeta. Cópiala, la usas en el paso 6.

En el tier gratuito Google puede usar las peticiones para mejorar sus modelos. Para
dudas de Magic da igual, pero conviene saberlo.

---

## Paso 3 — Token de Cloudflare

1. Crea cuenta en <https://dash.cloudflare.com/sign-up> si no la tienes. El plan
   gratuito vale.
2. Ve a <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** →
   plantilla **Edit Cloudflare Workers** → *Continue* → *Create Token*.
3. Copia el token. **Solo se enseña una vez.**
4. Necesitas también el *Account ID*: está en la barra lateral de la sección
   Workers & Pages del panel.

---

## Paso 4 — Meter esos dos valores en GitHub

En tu repo: **Settings → Secrets and variables → Actions → New repository secret**.
Crea dos:

| Nombre | Valor |
|---|---|
| `CLOUDFLARE_API_TOKEN` | el token del paso 3 |
| `CLOUDFLARE_ACCOUNT_ID` | el Account ID del paso 3 |

---

## Paso 5 — Primer despliegue

Pestaña **Actions** del repo → *Construir y desplegar* → botón **Run workflow**.

Tarda un par de minutos. Lo que hace:

1. Descarga el `.txt` de las Comprehensive Rules de la web oficial.
2. Lo trocea en unas 2.500 reglas y lo guarda en `data/cr.json`.
3. Crea el Worker en tu cuenta de Cloudflare y lo despliega con la web y las
   reglas dentro.

En el log del paso *Descargar y trocear* debe salir el número de reglas. Las
Comprehensive Rules de 2026 rondan las 3.100 contando subreglas. Si sale mucho menos
de 2.000, el parseo ha fallado.

Si el paso de descarga falla porque Wizards no expone el enlace en el HTML, edita
`.github/workflows/deploy.yml` desde la web de GitHub y cambia esa línea por:

```yaml
run: python tools/build_rules.py --url "PEGA_AQUI_EL_ENLACE_TXT"
```

El enlace lo sacas de <https://magic.wizards.com/en/rules>, botón derecho sobre TXT →
copiar dirección.

Al terminar, en el log del paso *Desplegar el Worker* verás tu URL:

```
https://mtg-juez.TU-SUBDOMINIO.workers.dev
```

---

## Paso 6 — El secreto de Gemini

En <https://dash.cloudflare.com> → **Workers & Pages** → `mtg-juez` → **Settings** →
**Variables and Secrets** → *Add*, de tipo **Secret** (no Text):

| Nombre | Valor |
|---|---|
| `GEMINI_API_KEY` | la clave del paso 2 |

Eso es todo lo que necesita el Worker. El control de quién entra se hace en el
paso 8, por delante y sin tocar código.

## Paso 7 — Probar

Abre tu URL. Deberías ver la pantalla de elegir formato, y abajo del todo la fecha de
vigencia de las reglas y cuántas hay indexadas. Si ahí pone algo, el `cr.json` cargó
bien.

Elige formato y pregunta algo:

> Si bloqueo una criatura con arrollar con un 1/1, ¿cuánto daño pasa al jugador?

Comprueba las citas: los números de regla deben salir en color y abrirse al pulsarlos.

**Si algo falla**, mira `https://TU-URL/api/health` — devuelve la versión de reglas y
el modelo configurado, y no necesita clave.

---

## Paso 8 — Cuentas de usuario

La app tiene registro con usuario, correo y contraseña, confirmación por correo y
recuperación de contraseña. Hacen falta tres cosas: una base de datos, un servicio
de correo y dos secretos.

### 8.1 · Base de datos

En <https://dash.cloudflare.com> → **Storage & Databases → D1** → *Create database*.
Llámala `juez`. Copia el **Database ID** que aparece al crearla.

En GitHub, edita `wrangler.toml` y pega ese identificador:

```toml
[[d1_databases]]
binding = "DB"
database_name = "juez"
database_id = "AQUI_EL_ID_QUE_HAS_COPIADO"
```

**Las tablas se crean solas.** En cuanto el identificador esté en `wrangler.toml`, el
workflow ejecuta `schema.sql` en cada despliegue antes de publicar el Worker. Todas
las sentencias llevan `IF NOT EXISTS`, así que repetirlo no toca los datos.

Si prefieres hacerlo a mano, entra en la base de datos → pestaña **Console** y pega
`schema.sql`. Ojo: la consola de D1 parte el texto por los puntos y coma y falla con
*"Requests without any query are not supported"* si algún trozo queda vacío, así que
pega el fichero tal cual viene, sin añadir comentarios ni líneas sueltas. Si aun así
protesta, ejecuta las seis sentencias de una en una.

Crea cuatro tablas: usuarios, enlaces de un solo uso, sesiones y contador de intentos.

### 8.2 · Envío de correos

El plan gratuito de [Resend](https://resend.com) da 3.000 correos al mes y 100 al
día, sin tarjeta. Para tu grupo sobra: cada persona recibe dos correos en su vida.

1. Crea la cuenta en <https://resend.com>.
2. **Domains → Add Domain** y pon un dominio tuyo (por ejemplo `jiglesias.es`).
   Te da unos registros DNS; si el dominio está en Cloudflare, se añaden en dos
   minutos. Espera a que ponga **Verified**.
3. **API Keys → Create API Key**, permiso de envío. Cópiala.

No uses el dominio de pruebas de Resend: solo permite mandarte correos a ti mismo.

### 8.3 · Los cuatro secretos

Panel de Cloudflare → tu Worker → **Settings** → **Variables and Secrets**, todos de
tipo **Secret**:

| Nombre | Valor |
|---|---|
| `GEMINI_API_KEY` | la clave del paso 2 |
| `AUTH_PEPPER` | una cadena larga y aleatoria que te inventes, 40+ caracteres |
| `RESEND_API_KEY` | la clave de Resend |
| `MAIL_FROM` | el remitente, por ejemplo `Juez <juez@jiglesias.es>` |

`AUTH_PEPPER` es la pimienta de las contraseñas. **Si la cambias, todas las
contraseñas dejan de funcionar** y hay que restablecerlas. Guárdala en un sitio
seguro y no la toques.

Vuelve a desplegar (Actions → Run workflow) y ya está.

---

## Cómo se guardan las contraseñas

Merece un apartado, porque la solución no es la de manual y conviene saber por qué.

El plan gratuito de Workers da **10 ms de CPU por petición**. Medido aquí mismo,
PBKDF2-SHA256 con 50.000 iteraciones ya cuesta 8,9 ms, y las 600.000 que recomienda
OWASP se van a 102 ms. Hacer el estirado entero en el servidor tumbaría la petición
con un error 1102.

Así que el estirado se reparte:

- **El navegador** hace las 600.000 iteraciones sobre la contraseña, con una sal
  única por usuario. Le cuesta unos 100 ms, una sola vez, al pulsar el botón.
- **El Worker** recibe esa clave derivada, le aplica otras 8.000 iteraciones y encima
  un HMAC con `AUTH_PEPPER`. Coste medido: 3,6 ms, dentro del presupuesto.

Quien robase la base de datos tendría que romper 608.000 iteraciones por contraseña
**y además** conocer la pimienta, que no está en la base de datos sino en los
secretos del Worker. La contraseña en claro no sale nunca del navegador.

Otras decisiones que hay detrás:

- Usuario o contraseña incorrectos dan **el mismo mensaje**, y el servidor gasta el
  mismo tiempo en ambos casos, para que no se pueda averiguar quién tiene cuenta.
- "He olvidado mi contraseña" responde igual exista o no el correo.
- Al registrarse con un correo ya usado, la respuesta es idéntica a la de un registro
  nuevo. El nombre de usuario sí avisa de que está cogido, porque es público y hace
  falta para elegir otro.
- De los enlaces de confirmación y restablecimiento se guarda solo el hash. Sirven
  una vez y caducan: 24 horas el de confirmación, 1 hora el de contraseña.
- Cambiar la contraseña cierra todas las sesiones abiertas.
- Límite de intentos: 10 por usuario cada cuarto de hora, 30 por IP, 5 registros por
  IP y hora, 5 recuperaciones por correo y hora.
- La cookie de sesión es `HttpOnly`, `Secure` y `SameSite=Lax`, y dura 30 días.

---

## Paso 9 (opcional) — Tu dominio

Panel de Cloudflare → tu Worker → **Settings** → **Domains & Routes** → *Add custom
domain*. Por ejemplo `magic.jiglesias.es`. Si el dominio ya está en Cloudflare, el
certificado se genera solo. Acuérdate de actualizar el dominio en la aplicación de
Access.

---

## Instalarla como app

Es una PWA, así que se instala desde el propio navegador sin pasar por ninguna tienda:

- **Android:** abre la URL en Chrome y pulsa *Instalar la app* en el pie, o el menú
  de tres puntos → *Añadir a pantalla de inicio*.
- **iPhone:** Safari → botón de compartir → *Añadir a pantalla de inicio*.
- **Escritorio:** Chrome o Edge muestran un icono de instalar en la barra de
  direcciones.

Queda con su icono, sin barra de navegador y a pantalla completa. El service worker
(`public/sw.js`) guarda la interfaz, las fuentes y las imágenes de carta, así que
abre al instante. Las respuestas del juez **nunca** se guardan en caché: necesitan
red, y una respuesta vieja sería peor que ninguna.

Los iconos se generan con `python3 tools/make_icons.py`. Si cambias el sello, vuelve
a ejecutarlo y súbelos.

---

## Mantenimiento

Ninguno. El workflow se ejecuta cada lunes: descarga las reglas del momento, las
trocea y redespliega el Worker con ellas dentro.

`data/cr.json` **no se versiona**: se genera fresco en cada ejecución. Lleva un campo
con la fecha de generación, así que si se commiteara cambiaría en cada run y los
commits automáticos acabarían pisándose entre ellos. Para saber qué versión está
desplegada, mira `/api/health`.

Para forzarlo cuando salga colección nueva: **Actions → Run workflow**. Dos clics.

Para cambiar cualquier fichero: edítalo desde la web de GitHub con el botón del lápiz.
Al confirmar, el workflow se dispara solo y redespliega.

---

## Cómo se usa

**El juez recuerda la conversación.** Puedes contestarle, matizar o añadir datos y
sigue el hilo: se le mandan los últimos 8 mensajes como contexto. La conversación se
guarda en el dispositivo, así que sobrevive a cerrar la app. El botón *Nueva consulta*
la borra y empieza de cero, que conviene al cambiar de situación de juego.

Al abrir, eliges formato. Si es Commander o casual multijugador puedes escribir
vuestros acuerdos de mesa: el juez los tendrá en cuenta sin que pisen las reglas
del juego.

Para citar una carta, ponla entre corchetes dobles: `[[Lightning Bolt]]`. El Worker
va a Scryfall, trae el texto oracle en inglés (el autoritativo), los rulings
oficiales y la legalidad en tu formato. Funciona con nombres en castellano.

Si la pregunta no tiene bastante información, el juez responde con opciones pulsables
en lugar de adivinar.

Los números de regla se pulsan y se abre el texto literal. **Si un número sale en gris
y no se puede pulsar, es que el modelo se lo ha inventado**: no estaba entre las
reglas recuperadas. Esa es la señal de alarma.

---

## Cómo tocarlo

Todo se edita desde la web de GitHub.

**El diccionario ES→EN es lo que más rendimiento da.** Está en `src/glossary.js`.
Cuando una pregunta traiga reglas que no pintan nada, mira qué término no estaba
mapeado y añádelo. Es la mejora más barata que hay.

**Modelo de Gemini:** la constante `MODELS` al principio de `src/index.js`. Se
prueban en orden y responde el primero que funcione.

Dos avisos por experiencia propia. Primero, evita los alias tipo
`gemini-flash-latest`: apuntan al Flash más potente, que razona sin límite y puede
tardar minutos en una pregunta de reglas hasta morir por tiempo de espera. Segundo,
Google retira modelos para claves nuevas sin quitarlos del catálogo, así que la lista
que devuelve `/api/diag` puede incluir modelos que dan 404 al usarlos; cuando pasa, el
propio error de Google te dice cuál es el sustituto.

**Razonamiento:** `THINKING_BUDGET` (generación 2.5, en tokens) y `THINKING_LEVEL`
(generación 3, por niveles). El código prueba las dos formas y, si el modelo no acepta
ninguna, va sin techo. Súbelo si falla en casos enrevesados como capas o efectos de
reemplazo apilados; bájalo o pon el presupuesto a 0 si te sobra calidad y quieres
gastar menos cuota.

**Cuánto contexto se manda:** `maxRules` en `src/retrieval.js` (26 por defecto) y el
tope duro de 70. Más reglas no siempre es mejor: pasado cierto punto añades ruido.

**Secciones forzadas por formato:** `FORMAT_SECTIONS` en `src/retrieval.js`.

**Tono y comportamiento del juez:** `systemPrompt` en `src/prompt.js`.

---

## Una nota técnica sobre el plan gratuito

Workers Free da **10 ms de CPU por petición**. Construir el índice BM25 sobre las
2.500 reglas cuesta unos 80 ms, así que se hace en el ámbito del módulo
(`INDEX = buildIndex()` al final de `retrieval.js`), no dentro del handler. Ahí cuenta
contra el límite de arranque, que son 400 ms. Medido: ~170 ms de arranque y ~2,8 ms
por consulta.

Si alguna vez mueves eso dentro del handler, la primera petición de cada isolate
morirá con un error 1102. Está avisado en un comentario dentro del fichero.

---

## Límites que conviene tener presentes

Los modelos de lenguaje fallan en los casos raros de Magic: capas (CR 613), efectos
de reemplazo apilados, marcas de tiempo. Por eso el sistema obliga a citar y enseña
la fuente — no elimina el error, lo hace visible.

En torneo manda el juez, no esto.

Scryfall cede sus datos gratis bajo la Fan Content Policy de Wizards: no puedes
cobrar por la app ni ponerle muro de pago. Como es para tu grupo, ningún problema.
