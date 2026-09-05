// Correos transaccionales vía Resend. Plan gratuito: 3.000 al mes, 100 al día.
// Necesita dos secretos en el Worker: RESEND_API_KEY y MAIL_FROM.

const ESTILO = `font-family:Georgia,'Times New Roman',serif;line-height:1.6;color:#191510`;

function plantilla({ titulo, saludo, cuerpo, boton, enlace, pie }) {
  return `<!doctype html><html lang="es"><body style="margin:0;padding:0;background:#14100C">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#14100C;padding:32px 16px">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#F2EAD8;border:1px solid #0A0704;border-radius:8px">
    <tr><td style="padding:22px 26px 14px;border-bottom:1px solid #B6A47A">
      <div style="font-family:Georgia,serif;font-size:15px;letter-spacing:.22em;color:#8A6E18;font-weight:bold">J U E Z</div>
    </td></tr>
    <tr><td style="padding:24px 26px;${ESTILO}">
      <h1 style="margin:0 0 14px;font-size:19px;font-weight:normal">${titulo}</h1>
      <p style="margin:0 0 14px">${saludo}</p>
      <p style="margin:0 0 22px">${cuerpo}</p>
      <p style="margin:0 0 22px">
        <a href="${enlace}" style="display:inline-block;background:#C9A227;color:#181207;text-decoration:none;padding:12px 22px;border-radius:5px;font-weight:bold;letter-spacing:.06em">${boton}</a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;color:#67593F">Si el botón no funciona, copia este enlace en el navegador:</p>
      <p style="margin:0 0 20px;font-size:12px;color:#67593F;word-break:break-all">${enlace}</p>
      <p style="margin:0;font-size:13px;color:#67593F;font-style:italic;border-top:1px solid #B6A47A;padding-top:14px">${pie}</p>
    </td></tr>
  </table>
  <p style="max-width:480px;margin:16px auto 0;font-family:Georgia,serif;font-size:11px;color:#7A6E58;font-style:italic">
    Juez es una herramienta privada de consulta de reglas de Magic: The Gathering.
    No está afiliada a Wizards of the Coast.
  </p>
</td></tr></table></body></html>`;
}

async function enviar(env, { to, subject, html, text }) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    throw new Error("Faltan los secretos RESEND_API_KEY o MAIL_FROM en el Worker");
  }

  // El remitente sale de un subdominio (send.mtg-juez.com) porque el MX de la
  // raiz lo necesita Cloudflare Email Routing para recibir en hola@. Pero si
  // alguien responde a un correo de confirmacion, queremos que llegue al buzon
  // de verdad y no se pierda.
  const cuerpo = { from: env.MAIL_FROM, to: [to], subject, html, text };
  if (env.MAIL_REPLY_TO) cuerpo.reply_to = env.MAIL_REPLY_TO;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const detalle = (await res.text()).slice(0, 300);
    throw new Error(`Resend ${res.status}: ${detalle}`);
  }
}

export async function enviarVerificacion(env, { to, username, enlace }) {
  const html = plantilla({
    titulo: "Confirma tu correo",
    saludo: `Hola, ${username}.`,
    cuerpo:
      "Alguien ha creado una cuenta en Juez con esta dirección. Confírmala y podrás " +
      "entrar con tu nombre de usuario y tu contraseña.",
    boton: "Confirmar mi correo",
    enlace,
    pie: "El enlace caduca en 24 horas. Si no has sido tú, ignora este mensaje: sin confirmar, la cuenta no sirve para nada.",
  });
  await enviar(env, {
    to,
    subject: "Confirma tu cuenta de Juez",
    html,
    text: `Hola, ${username}. Confirma tu correo para entrar en Juez: ${enlace}\n\nEl enlace caduca en 24 horas.`,
  });
}

export async function enviarRestablecimiento(env, { to, username, enlace }) {
  const html = plantilla({
    titulo: "Restablecer la contraseña",
    saludo: `Hola, ${username}.`,
    cuerpo:
      "Has pedido cambiar la contraseña de tu cuenta de Juez. Pulsa el botón y elige una nueva.",
    boton: "Elegir contraseña nueva",
    enlace,
    pie: "El enlace caduca en 1 hora y solo sirve una vez. Si no lo has pedido tú, no hagas nada: tu contraseña actual sigue funcionando.",
  });
  await enviar(env, {
    to,
    subject: "Restablecer tu contraseña de Juez",
    html,
    text: `Hola, ${username}. Para elegir una contraseña nueva: ${enlace}\n\nEl enlace caduca en 1 hora.`,
  });
}

export async function enviarCambioCorreo(env, { to, username, nuevo, enlace }) {
  const html = plantilla({
    titulo: "¿Cambias tu correo?",
    saludo: `Hola, ${username}.`,
    cuerpo:
      `Has pedido cambiar el correo de tu cuenta de Juez a <strong>${nuevo}</strong>. ` +
      "Confírmalo desde aquí, que es tu dirección actual.",
    boton: "Sí, cambiar mi correo",
    enlace,
    pie:
      "El enlace caduca en 1 hora. Si no has sido tú, no hagas nada y tu correo seguirá " +
      "igual; aprovecha para cambiar la contraseña por si acaso.",
  });
  await enviar(env, {
    to,
    subject: "Confirma el cambio de correo en Juez",
    html,
    text: `Hola, ${username}. Confirma el cambio de tu correo a ${nuevo}: ${enlace}\n\nCaduca en 1 hora.`,
  });
}
