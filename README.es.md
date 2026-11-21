# Antigravity Suite

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español**

> **Suite de mejoras y control remoto 100 % sin parches (Zero-Patch) para Google Antigravity en escritorio (macOS). Nunca modifica `app.asar` ni la firma oficial de Apple, no interfiere con actualizaciones y se activa o desactiva al instante.**

## Funciones principales

1. **🇨🇳 Cambio instantáneo entre chino simplificado e inglés (traducción local sin tokens)**: Traduce y almacena localmente pensamientos y títulos sin consumir cuota, con cambio de idioma en vivo desde **`⚙️`**.
2. **📱 Control remoto ultrarrápido para móvil y escritorio (mucho más rápido que el oficial)**:
   - Conexión directa en LAN en milisegundos o selección automática de la ruta más rápida (Tailscale, Bonjour o túnel Cloudflare sin inicio de sesión por defecto), evitando demoras del relé oficial en la nube; PWA ligera que al cambiar de chat solo cancela la carga pendiente de la vista anterior (sin interrumpir la IA en segundo plano), con carga diferida del historial y compresión **`gzip`**.
   - Cambio entre proyectos (indicadores de no leído/aprobación), desplazamiento completo del historial sin pérdida, creación remota y explorador de archivos/diffs dentro del límite `$HOME`, cola de mensajes (enviar/retirar), subida de archivos e imágenes con vista previa, tarjetas interactivas de confirmación, paneles superiores, 9 interruptores, sesiones aisladas por pestaña y envío `Cmd/Ctrl + Enter` protegido contra IME.
3. **⚡ Comandos rápidos y optimización de prompts (`Insertar` vs `⚡Envío directo`)**:
   - **14 comandos recomendados integrados** (conversión a píldoras nativas) + **10 plantillas populares en un clic**.
   - **`Insertar`** coloca texto para añadir errores o contexto; **`⚡Envío directo`** (`↵`) envía al instante (8 frases cortas por defecto), con protección de borrador e inversión **`⌘/Ctrl + clic`**, además de **`✨ Optimizar` / `↩ Deshacer`** y sugerencias **`Tab / →`**.
4. **🧰 Utilidades rápidas de escritorio**: **`⌘1`–`⌘9`** para saltar entre conversaciones, barra flotante de navegación de mensajes, edición directa con **`✏️ Editar` + `⌘S`** y lanzador **`>_ CLI`** (compatible con `v2.32.x–2.34.0`, `SingletonSocket` y detección automática de Node `nvm`/`fnm`/`volta`/`asdf`/`mise`).
5. **📊 Monitor de contexto, autocompactación a 240K y cuotas duales**: Anillo superior con uso del contexto, mapa de calor de 52 semanas y costes API estimados, junto con cápsulas `G4` / `C` de cuota cada 5 horas y semanal; envía `/compact` automáticamente al alcanzar 240K o detectar caída de caché (alerta 328K) para evitar bloqueos de varios minutos.
6. **🛡️ Bloqueo con marco rojo ante comandos peligrosos**: Intercepta comandos destructivos (`rm -rf`, `git reset --hard`, `sudo`) y exige confirmación manual incluso si la aprobación automática está activada.
7. **🔄 Detcción automática y actualización en caliente con un clic**: Muestra un punto rojo en **`⚙️`** cuando hay una nueva versión en GitHub para aplicar cambios al instante sin reiniciar Antigravity.

---

## 🚀 Instalación rápida (macOS · CDP sin modificar paquete)

Requisitos: **macOS**, **Google Antigravity** y **Node.js `22.4.0+`**.

```bash
git clone https://github.com/iamvicliu/antigravity-suite.git ~/.local/share/antigravity-suite
cd ~/.local/share/antigravity-suite
./scripts/setup-macos-cdp.sh
```

> Opciones: `--no-auto` omite el inicio automático (`ag-context-meter install-launcher` crea un lanzador opcional en `~/Applications`) y `--no-remote` desactiva el servidor remoto. En Windows / Linux puedes iniciar Antigravity con depuración remota y ejecutar `node cli.js live`.

### Comandos diarios

- `ag-context-meter status`: comprueba los módulos activos y la integridad oficial de `app.asar`.
- `ag-context-meter remote`: muestra el QR de los 4 canales y dispositivos conectados (`--tunnel on|off`, `--reset-token`).
- `ag-context-meter live` / `restart`: inyecta al instante o reinicia con puerto CDP habilitado (`v2.33.0+`).
- `ag-context-meter update` / `stop` / `auto-off`: actualiza en caliente, detiene la sesión actual o desactiva el arranque automático.

Ejecuta `npm run test:suite` para correr las pruebas. Agradecimiento especial a los colaboradores [@hubo1989](https://github.com/hubo1989) y [@Shens](https://github.com/Shens) por sus optimizaciones en el emparejamiento QR, el control remoto y la experiencia de uso. Para más detalles, consulta el **[README en chino simplificado](README.md)** o el **[README en inglés](README.en.md)**. Bajo licencia [MIT License](LICENSE).
