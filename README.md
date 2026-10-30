# Servidor de medida y montaje (ffmpeg)

Hace lo que la app no puede hacer por sí sola: limpiar y medir la voz de cada clip (§3.4), montar el vídeo final con ducking, −15 LUFS y subtítulos en zona segura (§3.7) y medir el resultado para la Revisión 2.

## Desplegar en Render (unos 7 $/mes)

1. Sube **esta carpeta entera** a un repositorio nuevo de GitHub (los tres archivos: `Dockerfile`, `server.mjs` y `render.yaml`).
2. Entra en <https://dashboard.render.com> → **New → Blueprint** → elige tu repositorio.
3. Render lee `render.yaml` y lo deja preparado solo: Docker, plan *Starter* y una contraseña (`TOKEN`) generada automáticamente. Dale a **Apply** y espera a que diga **Live**.
4. Abre en el navegador `TU-DIRECCION/salud`. Debe aparecer `{"ok":true}`. Si no aparece, el servicio todavía no está en marcha o la dirección es otra.
5. Copia la dirección y la contraseña: la dirección está en **Settings → Information → External URL** y la contraseña en **Environment** (valor de `TOKEN`).
6. En el panel de super admin de la app, fila **«Servicio de montaje FFmpeg»**, pega `DIRECCION|CONTRASEÑA` y pulsa **Guardar** y después **Comprobar**.

## Si «not found»

`https://estudio-ffmpeg.onrender.com` no es una dirección fija: cada servicio recibe la suya según el nombre que le pongas. Si al abrirla con `/salud` el navegador dice *Not Found*, es que en Render no hay ningún servicio con ese nombre (todavía no se creó, se borró, o se creó con otro nombre).

- Busca el servicio en el panel de Render y copia la **External URL** real de la pestaña Settings.
- Si no existe ninguno, vuelve al paso 1 y créalo con **New → Blueprint**.

## Por qué el plan de pago

Un montaje de varios clips tarda minutos. En el plan gratuito Render duerme el servicio cuando no recibe visitas y corta los trabajos en marcha, así que el montaje se interrumpiría a mitad.

## Comprobación manual

`GET /salud` responde `{"ok":true}` sin contraseña. El resto de rutas (`/medir`, `/montar`, `/job/...`) exigen la cabecera `Authorization: Bearer <TOKEN>`.
