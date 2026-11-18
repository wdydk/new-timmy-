# Timmy Max v3

Bot de comunidad para Discord, escrito de nuevo: bienvenidas, despedidas, autorroles, reacciones, roles con botones, respuestas personalizadas, moderación, tickets, IA en servidor y DM, Spotify y música. 56 comandos con prefijo y slash. Proyecto propio inspirado en funciones de bots de comunidad; no es una copia ni una implementación de todo Bleed.

## Instalar en tu Railway actual

1. Descarga y descomprime `Timmy-Max-v3.zip`.
2. Guarda una copia del repositorio anterior y, si quieres conservar pruebas de tickets, exporta sus transcripciones. No subas el `.env` ni la memoria privada a GitHub.
3. En GitHub, abre `wdydk/timmy-max-bot` → **Add file → Upload files**.
4. Sube **el contenido** de la carpeta `timmy-max-v3`, no el ZIP ni una carpeta que deje `index.js` anidado. Deben quedar `index.js`, `package.json`, `package-lock.json`, `Dockerfile`, `railway.json`, `src/` y `scripts/` en la raíz. Sube también los archivos de documentación y `test/` si quieres las pruebas. Actualiza `.gitignore` y `.dockerignore` desde el ZIP si el selector oculta esos archivos.
5. Haz un solo commit con todos los cambios. **Reemplazar únicamente index.js no funciona:** ahora usa los módulos de `src/` y dependencias diferentes.
6. En Railway conserva `DISCORD_TOKEN` y `GEMINI_API_KEY`. Añade `GUILD_ID` (ID de tu servidor), `GEMINI_MODEL=gemini-3.5-flash-lite`, `PREFIX=>` y `REGISTER_SLASH=true`.
7. Conecta un volumen al servicio con ruta **`/data`**. Railway inyecta `RAILWAY_VOLUME_MOUNT_PATH`. No montes el volumen sobre `/app`, donde está el código.
8. Usa **una sola réplica**. Desactiva Serverless/suspensión si estuviera activo. Deja que el Dockerfile instale Python, FFmpeg, yt-dlp y las dependencias. No hace falta dominio público ni un servidor HTTP para este bot.
9. Espera a ver en los logs: `Timmy Max v3 conectado`, `Archivo de memoria: /data/timmy-v3.json` y `56 comandos / registrados`.
10. Apaga la copia del bot que tengas abierta en tu PC. Prueba `>ping`, `>help`, `/help` y un DM al bot.

El inicio reemplaza el catálogo GLOBAL de comandos de esta aplicación por el nuevo. Si defines GUILD_ID también reemplaza el catálogo de ese servidor, para retirar los viejos `/hola` y `/ping` de la captura. No toca comandos de otras aplicaciones. Si tienes comandos antiguos registrados en otros servidores, define ese servidor como GUILD_ID y despliega para reemplazar su catálogo; vuelve luego a tu ID principal. Los comandos globales pueden tardar en aparecer; reabre Discord. Se requiere la autorización `applications.commands` en la invitación del bot.

Si Railway tiene comandos personalizados de inicio/build configurados de antes, quítalos o deja el inicio en `node index.js`; no uses `npm test` como inicio.

## Discord Developer Portal

En la aplicación → Bot → Privileged Gateway Intents activa:

- **Server Members Intent** (bienvenida/autorrol).
- **Presence Intent** (`>sf`).
- **Message Content Intent** (comandos con prefijo y chat en servidor).

Invita la aplicación con scopes `bot` y `applications.commands`. Permisos del bot según las funciones que vayas a usar:

- Ver canales, Enviar mensajes, Insertar enlaces, Adjuntar archivos, Leer historial, Añadir reacciones.
- Conectar y Hablar para música.
- Gestionar roles para autorrol y roles con botones; coloca el rol del bot por encima de los roles que gestione.
- Gestionar canales para tickets y slowmode; Gestionar roles para sobrescrituras de canales.
- Gestionar mensajes, Moderar miembros, Expulsar miembros, Banear miembros para moderación.

No hace falta Administrador. Las funciones que carezcan de permisos mostrarán error. Tener un permiso de staff no concede todas las acciones. El bot también respeta la jerarquía del moderador. Nunca quita roles administrativos para forzar un timeout.

## Configuración inicial (ejemplos)

Ejecuta los siguientes en Discord, reemplazando las menciones/IDs por los tuyos. Necesitas los permisos correspondientes.

```text
>logs #logs
>welcome #bienvenidas ¡Bienvenido {user} a {server}! Ya somos {count}.
>welcome test
>goodbye #despedidas {username} salió de {server}.
>autorole @Miembro
>autoreact add "hola" 👋
>autoreact add "buenas noches" 🌙
>responder add redes Síguenos en nuestras redes; consulta el canal de anuncios.
>rolebutton @Eventos Avisos de eventos
>snipeconfig on
>automod on
>knowledge Aquí puedes explicar las normas, horarios y cómo contactar al staff.
>ticketsetup ID_DE_LA_CATEGORIA @Soporte
>ticketpanel
>config
```

- Las variables de bienvenida/respuestas son `{user}`, `{username}`, `{server}`, `{count}`.
- `>autoreact remove "hola"` quita una reacción; `>autoreact list` muestra las configuradas.
- Los roles automáticos y voluntarios deben ser roles sin poderes de moderación.
- `>responder add redes ...` crea `>redes`; no crea un nuevo slash dinámico.
- `>welcome off`, `>goodbye off`, `>autorole off` y `>logs off` desactivan esas funciones.
- Snipe está apagado inicialmente. `>snipe` y `>editsnipe` requieren Gestionar mensajes, solo recuperan texto observado mientras el bot estaba en línea y caducan a los 5 minutos. No recuperan archivos borrados ni mensajes previos al arranque. Por slash, la respuesta es privada; con prefijo se publica en el mismo canal.
- El antispam es una regla simple y opcional: 6 mensajes en 5 segundos en el mismo canal. Intenta eliminar el exceso y aplicar 1 minuto de timeout. Omite bots y moderadores. No es un sistema antiraid completo ni una garantía contra ataques.
- Los comandos de configuración slash usan un campo `opciones`. Ej.: `/welcome opciones:#bienvenidas Hola {user}`. No pongas el prefijo dentro de `opciones`.
- `>help` enumera todo; `>help Música` muestra solo una categoría. `COMMANDS.md` contiene la lista completa.

## IA y mensajes privados

- Funciona con tu variable **GEMINI_API_KEY**. Si falta la clave, el resto del bot funciona.
- Consulta con `>ask pregunta`, `/ask` o una mención directa al bot.
- Por DM, escribe directamente al bot. No hace falta prefijo. La IA responde a mensajes recibidos; no envía DMs masivos ni contacta por iniciativa propia a miembros.
- El usuario debe permitir los DMs correspondientes en Discord. El bot no puede eludir sus ajustes.
- Esta versión admite **texto**, no interpreta capturas/voz ni adjuntos. Para un reporte, el staff revisa las pruebas en el ticket.
- La consulta y hasta 6 turnos anteriores del mismo usuario y chat se envían a Gemini. No se añade contenido de otros canales ni usuarios.
- El contexto se mantiene en RAM, caduca tras 2 horas sin uso y se pierde al reiniciar. `>forget` elimina el contexto de ese usuario en ese chat. `>privacy` explica el uso de datos.
- `>aiconfig off` desactiva IA en el servidor. `AI_DM_ENABLED=false` desactiva la IA en DMs.
- `>knowledge texto` añade hasta 4000 caracteres de información de soporte solo de ese servidor.
- La IA no ejecuta moderación, no lee otros canales, no entrega roles y no toma decisiones sobre reportes. Ya no existe Berserk/Hellflash ni castigos por insultar al personaje.
- Hay cooldown por usuario y máximo 3 consultas simultáneas. No se envían múltiples llamadas al fallar por cuota. El consumo de Gemini es independiente de Railway. El modelo es configurable: si tu cuenta no tiene acceso al predeterminado, usa un modelo disponible para tu clave.

## Música: reparación y comprobación

El proyecto usa una única sesión por servidor, control serial de la cola y eventos compartidos tanto para `>join` como para `>play`. El Dockerfile instala el yt-dlp de Linux, sus dependencias de JavaScript y FFmpeg. No se utiliza `yt-dlp.exe`, no se desactiva la verificación TLS y no se ocultan los errores de FFmpeg.

El anuncio de reproducción se envía solo después de recibir PCM y entrar en **Playing**. Eso confirma el procesamiento local; no prueba por sí solo que un usuario haya oído el sonido.

Prueba en este orden:

```text
>stop
>join
>audiotest
>musicdiag
>play nombre de la canción y artista
>queue
```

`>stop` puede responder que no hay sesión si aún no entraste: es normal. Entra tú primero en un canal de voz normal, no un escenario. La prueba genera un tono suave de 3 segundos sin usar YouTube.

| Resultado | Qué revisar |
| --- | --- |
| No conecta a voz | Conectar/Hablar, silencio del bot, conexión UDP del hosting y logs. |
| Se oye el tono pero no YouTube | La voz funciona; revisa errores yt-dlp/YouTube, disponibilidad del video y restricciones de la IP del hosting. |
| No oyes el tono pero hay PCM y Playing | Revisa el volumen individual del bot en tu Discord, tu salida de audio, silencio del servidor y la conexión de voz. |
| PCM en cero o fallo de FFmpeg | Revisa el Dockerfile nuevo y los logs de despliegue/audio. |
| Error 403/429 o “sign in / not a bot” | YouTube puede rechazar centros de datos. No se garantiza reproducir todos los videos ni se eluden restricciones. |

Hay soporte DAVE a través de @discordjs/voice y su dependencia. El diagnóstico de arranque muestra qué librerías se cargaron. `npm run doctor` comprueba herramientas locales, no una sesión real de Discord.

Funciones: play, join, stop/leave, skip, pause, resume, volume 0–100, loop off/song/queue, queue, nowplaying, shuffle, audiotest y musicdiag. Todos los controles de modificación requieren estar en el mismo canal de voz. Opcional: `>djrole @DJ` restringe los controles; `>djrole off` quita esa restricción. Cualquiera en el canal puede pedir una canción dentro de los límites.

- `>sf` lee Spotify compartido en Discord; no reproduce audio ni muestra un historial de escuchas.
- Un enlace de Spotify se convierte en una búsqueda aproximada de YouTube usando el título de oEmbed. Puede no coincidir con la grabación exacta; indicar artista y título mejora el resultado. No reproduce el catálogo de Spotify directamente.
- Máximo 30 minutos por pista, 50 pistas pendientes y 10 pendientes por usuario. Sin playlists ni directos.
- Desconexión tras 30 segundos de canal vacío o 2 minutos sin pista. La cola de música es temporal y no se recupera tras un despliegue.
- Para actualizar yt-dlp en el futuro, cambia `ARG YTDLP_VERSION` del Dockerfile por una versión publicada y vuelve a desplegar. Consulta primero los logs; no cambies dependencias a ciegas.

## Tickets

1. Configura categoría y rol específico de soporte con `>ticketsetup`.
2. Publica `>ticketpanel` en un canal de texto.
3. El usuario selecciona categoría y rellena un formulario de hasta 1000 caracteres.
4. Se permite un ticket abierto por usuario y servidor. La IA responde al texto que envía el autor dentro del ticket.
5. Soporte puede atender/reclamar el ticket y pausar/reactivar IA. Reclamar pausa IA automáticamente.
6. Solo el autor y soporte pueden exportar/cerrar. El cierre necesita confirmación.
7. Antes de eliminar el canal se guarda la transcripción en `/data/transcripts/ID.txt`; si falla el guardado no se elimina el canal.

Las transcripciones incluyen hasta los últimos 1000 mensajes y enlaces de adjuntos, no los archivos multimedia. Los enlaces pueden caducar. No se envían transcripciones a un canal público. Los administradores de Discord siempre pueden acceder a canales privados. Los registros de moderación solo anuncian IDs/estados de tickets, sin copiar su contenido.

Las transcripciones permanecen en el volumen hasta que el administrador las retire o borre el volumen. Define tu política de retención e informa a la comunidad.

## Memoria nueva y copias de seguridad

Este es un reinicio de configuración: el nuevo bot usa **timmy-v3.json**, empieza sin reglas ni tickets registrados y **no carga ni borra** el viejo `bot_memory.json`. Los canales antiguos siguen existiendo pero sus botones viejos no funcionan con esta versión; archívalos manualmente después de conservar las pruebas. Vuelve a publicar los paneles nuevos.

La memoria guarda configuración por servidor, advertencias y tickets activos. Cada guardado escribe un temporal, lo sincroniza y lo renombra, conservando la versión anterior como `timmy-v3.json.bak`. No borra memoria si el JSON está corrupto: detiene el inicio y permite recuperar la copia. No hay comandos `wipe` o `nuke`.

La copia `.bak` está en el mismo volumen y no protege frente al borrado del volumen. Para restaurar, detén el bot y reemplaza `timmy-v3.json` por una copia válida. No edites el archivo mientras corre el bot. Configura además backups del volumen si tu plan los ofrece.

## Ejecutar en PC

Necesitas Node.js 24.17+ de la rama 24, Python 3.11+, FFmpeg en PATH y yt-dlp:

```sh
python -m pip install "yt-dlp[default]==2026.10.26"
npm ci
npm run check
npm run doctor
```

Copia `.env.example` a `.env`, rellena las variables y ejecuta `npm start`. Si FFmpeg o yt-dlp no están en PATH, define sus rutas absolutas en `.env`. No ejecutes la copia local y Railway con el mismo token al mismo tiempo.

## Pruebas y límites de la entrega

`npm test` verifica permisos, jerarquía, aislamiento de memoria/IA, persistencia, JSON corrupto, formularios, catálogo slash, validación de fuentes de música, generación PCM con FFmpeg y codificación PCM→Opus con AudioPlayer. No necesita token de Discord ni clave de Gemini.

No se ha desplegado esta versión ni se han enviado mensajes con tu cuenta. No se ha confirmado audio real en tu servidor, acceso real de tu clave a Gemini ni todas las funciones contra la API de Discord. La comprobación final incluye unirse con dos cuentas, probar permisos, abrir/cerrar un ticket, escuchar el tono y reiniciar con una configuración guardada.

## Referencias técnicas

- https://discord.js.org/docs/packages/voice/main
- https://github.com/yt-dlp/yt-dlp
- https://docs.discord.com/developers/events/gateway
- https://docs.railway.com/volumes/reference
- https://ai.google.dev/gemini-api/docs/models

No se incluye el código propietario, marca, pagos, last.fm, redes sociales, economía, herramientas avanzadas antinuke ni todo el catálogo de Bleed. El alcance exacto es la lista COMMANDS.md.
