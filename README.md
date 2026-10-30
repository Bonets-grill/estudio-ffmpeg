# Servidor de medida y montaje (ffmpeg)

Hace lo que la app no puede hacer por sí sola: limpiar y medir la voz de cada clip (§3.4), montar el vídeo final con ducking, −15 LUFS y subtítulos en zona segura (§3.7) y medir el resultado para la Revisión 2.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Bonets-grill/estudio-ffmpeg)

**Desplegar de un clic:** <https://render.com/deploy?repo=https://github.com/Bonets-grill/estudio-ffmpeg>

## Desplegar en Render (unos 7 $/mes)

1. Pulsa el botón de arriba (o abre el enlace). Render lee `render.yaml` y lo deja preparado solo: Docker, plan *Starter* y una contraseña (`TOKEN`) generada automáticamente.
2. Abre en el navegador `TU-DIRECCION/salud`. Debe aparecer `{"ok":true}`. Si no aparece, el servicio todavía no está en marcha o la dirección es otra.
3. Copia la dirección y la contraseña: la dirección está en **Settings → Information → External URL** y la contraseña en **Environment** (valor de `TOKEN`).
4. En el panel de super admin de la app, fila **«Servicio de montaje FFmpeg»**, pega `DIRECCION|CONTRASEÑA` y pulsa **Guardar** y después **Comprobar**.

## Si «not found»

`https://estudio-ffmpeg.onrender.com` no es una dirección fija: cada servicio recibe la suya según el nombre que le pongas. Si al abrirla con `/salud` el navegador dice *Not Found*, es que en Render no hay ningún servicio con ese nombre (todavía no se creó, se borró, o se creó con otro nombre).

- Busca el servicio en el panel de Render y copia la **External URL** real de la pestaña Settings.
- Si no existe ninguno, pulsa de nuevo el botón **Deploy to Render** de arriba.

## Por qué el plan de pago

Un montaje de varios clips tarda minutos. En el plan gratuito Render duerme el servicio cuando no recibe visitas y corta los trabajos en marcha, así que el montaje se interrumpiría a mitad.

## Comprobación manual

`GET /salud` y `GET /health` responden con `ok: true` y la versión sin contraseña. El resto de rutas (`/medir`, `/montar`, `/job/...`) exigen la cabecera `Authorization: Bearer <TOKEN>`.

## Montajes resistentes a reinicios

La app espera hasta 90 segundos para despertar el servicio y reintenta los errores temporales tres veces (2, 5 y 10 segundos). Cada montaje tiene un identificador estable: repetir una petición no crea otro trabajo. Se comprueban los archivos antes de descontar créditos.

El estado y los datos para reanudar se guardan en almacenamiento privado de la app, además de una copia local. Tras un reinicio, al consultar el estado se recupera el trabajo y se vuelve a montar desde el principio; los enlaces de entrada duran 24 horas y los de subida tienen su propio plazo de caducidad. Si han caducado, el fallo se muestra y hay que iniciar otro montaje. No requiere un disco de pago en Render.

Los trabajos se procesan uno a uno, con cada escena por separado, y las descargas/subidas se transmiten sin cargar el vídeo entero en memoria. No se cambia el plan Starter.
