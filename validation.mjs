export function validarMontaje(p) {
  const fallo = (error) => { throw Object.assign(new Error(error), { status: 400 }); };
  const url = (valor, campo, obligatorio = true) => {
    if (!valor && !obligatorio) return;
    try { if (new URL(valor).protocol === "https:") return; } catch {}
    fallo(`${campo}: falta un enlace HTTPS válido`);
  };
  if (!p || !Array.isArray(p.escenas) || !p.escenas.length) fallo("escenas: añade al menos una escena");
  url(p.musicaUrl, "musicaUrl"); url(p.subidaUrl, "subidaUrl");
  url(p.estadoSubidaUrl, "estadoSubidaUrl");
  if (!/^[0-9a-f-]{36}$/i.test(p.job ?? "")) fallo("job: falta un identificador válido del trabajo");
  p.escenas.forEach((e, i) => {
    const campo = `Escena ${i + 1}`;
    if (!e || !["habla", "off", "plano", "cartela", "pantalla"].includes(e.tipo)) fallo(`${campo}: tipo no válido`);
    if (!Number.isFinite(e.duracion) || e.duracion <= 0) fallo(`${campo}: duracion debe ser mayor que cero`);
    if (["habla", "off", "plano"].includes(e.tipo)) url(e.clipUrl, `${campo}: clipUrl`);
    if (["habla", "off"].includes(e.tipo)) url(e.audioUrl, `${campo}: audioUrl`);
    url(e.imagenUrl, `${campo}: imagenUrl`, false);
    if (e.tipo === "habla" && (!Number.isFinite(e.inicio) || !Number.isFinite(e.fin) || e.inicio < 0 || e.fin <= e.inicio)) fallo(`${campo}: inicio/fin de la voz no válidos; vuelve a medir la voz`);
  });
}