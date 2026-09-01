// Comportamiento de la web comercial. Dos cosas, las dos discretas.

// ─── 1. Aparición al bajar ────────────────────────────────────────────────────
// Cada bloque entra una sola vez, con un desplazamiento corto. Nada de
// parallax ni de contadores: en una página que quiere parecer seria, el
// movimiento debe pasar casi desapercibido.
(function aparicion() {
  const quieto = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const objetivos = document.querySelectorAll("[data-aparece]");
  if (quieto || !("IntersectionObserver" in window)) {
    objetivos.forEach((el) => el.classList.add("visible"));
    return;
  }

  const observador = new IntersectionObserver(
    (entradas) => {
      for (const e of entradas) {
        if (!e.isIntersecting) continue;
        // Escalonado corto dentro de un mismo grupo, para que los bloques de
        // una rejilla no aparezcan todos de golpe
        const i = Number(e.target.dataset.orden || 0);
        e.target.style.transitionDelay = `${Math.min(i, 4) * 70}ms`;
        e.target.classList.add("visible");
        observador.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -12% 0px", threshold: 0.12 }
  );

  objetivos.forEach((el) => observador.observe(el));
})();

// ─── 2. Si ya tienes sesión, el botón lo sabe ─────────────────────────────────
// La API responde en los dos dominios, así que esta llamada es del mismo
// origen y lleva la cookie. Si la sesión está compartida entre mtg-juez.com y
// chat.mtg-juez.com, aquí se nota.
(async function sesion() {
  const botones = document.querySelectorAll("[data-entrar]");
  if (!botones.length) return;
  try {
    const res = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (!res.ok) return;
    const d = await res.json();
    if (!d.usuario) return;
    botones.forEach((b) => {
      b.textContent = b.dataset.entrar; // "Abrir el chat"
      b.title = d.usuario.username;
    });
  } catch {
    /* sin sesión o sin conexión: el botón se queda como estaba */
  }
})();
