# Verificación de la entrega

- Instalación limpia de dependencias con `npm ci`: completada.
- Sintaxis de index.js y los cinco módulos: correcta.
- 19 pruebas automatizadas: permisos, jerarquías, aislamiento de IA, cierre de tickets, persistencia, JSON corrupto, serialización de operaciones, catálogo slash, formulario de ticket, validación de fuentes, procesos fallidos, audio y eventos atrasados.
- FFmpeg generó 192000 bytes de PCM estéreo de 48 kHz para un segundo y se comprobó que no fueran todos cero.
- El tono PCM pasó por la codificación Opus y el AudioPlayer real alcanzó Playing antes de publicar el anuncio.
- Diagnóstico local: Node 24, @discordjs/voice 0.19.2, DAVE cargado, FFmpeg disponible y yt-dlp 2026.10.26 disponible.
- Una consulta de prueba a YouTube no se pudo completar por `CERTIFICATE_VERIFY_FAILED` en este entorno. No se desactivó TLS. Esto no identifica la causa del silencio en el Railway del usuario.

No verificado: construcción completa de la imagen Docker (Docker no disponible aquí), conexión autenticada a Discord, recepción real de audio por un usuario, cuota/clave real de Gemini, formularios/roles contra la API real y funcionamiento en la IP de Railway. El proyecto no se ha subido ni desplegado en el repositorio del usuario.

Prueba final recomendada: instalar en un servidor de prueba, comprobar todos los permisos con una cuenta sin staff, usar >audiotest, reproducir una pista accesible, abrir/cerrar un ticket y reiniciar con una bienvenida guardada.
