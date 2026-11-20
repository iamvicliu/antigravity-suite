# Antigravity Suite

[简体中文](README.md) · [English](README.en.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · **Español**

> **Suite de mejoras y control remoto 100 % sin parches (Zero-Patch) para Google Antigravity en escritorio (macOS). Nunca modifica `app.asar` ni la firma oficial de Apple, no interfiere con actualizaciones y se activa o desactiva al instante.**

## Funciones principales

- **📱 Control remoto multicanal para móvil y escritorio (Túnel Cloudflare sin inicio de sesión por defecto y aislamiento por sesión)**：Conéctate mediante LAN, Tailscale, Bonjour o túnel temporal de Cloudflare (habilitado por defecto, compatible con dominio fijo propio). Incluye prueba automática de ruta más rápida, paneles superiores de contexto y uso local, 9 interruptores de visualización y sesiones aisladas por pestaña (`X-AG-Client-Id`).
- **🛡️ Autocompactación a 240K y alerta en tiempo real de caída de caché (328K)**：Evita bloqueos de 4–5 minutos al expirar la caché en conversaciones largas enviando `/compact` automáticamente cuando alcanza 240K o cae la caché en reposo.
- **⚡ Suite de productividad en el editor**：Grupo de **14 comandos recomendados integrados** (agrupados por uso, tooltip de doble línea al pasar el cursor y conversión automática a píldoras nativas) + prompts personalizados, botón **`✨ Optimizar` / `↩ Deshacer`** con respaldo multimodelo, vista previa de sugerencias `Tab`, cambio rápido de chats con **`⌘1`–`⌘9`**, edición en línea con **`⌘S`** y lanzador **`>_ CLI`**.
- **📊 Monitor de contexto, mapa de calor de 52 semanas y cuotas duales**：Anillo superior con uso del contexto y costes API estimados, junto con cápsulas `G4` / `C` de cuota cada 5 horas y semanal para Gemini 4 y Claude.
- **🇨🇳 Cambio instantáneo entre chino simplificado e inglés (traducción local sin tokens)**：Traduce y almacena localmente pensamientos y títulos sin consumir cuota, con cambio de idioma en vivo desde **`⚙️`**.
- **🔄 Actualización en caliente y 🛡️ bloqueo de comandos peligrosos**：Actualización sin reiniciar desde el indicador rojo en **`⚙️`**, e interceptación con marco rojo ante comandos destructivos (`rm -rf`, `git reset --hard`, `sudo`).

---

## 🚀 Instalación rápida (macOS · CDP sin modificar paquete)

Requisitos: **macOS**, **Google Antigravity** y **Node.js `22.4.0+`**.

```bash
git clone https://github.com/iamvicliu/antigravity-suite.git ~/.local/share/antigravity-context-viewer
cd ~/.local/share/antigravity-context-viewer
./scripts/setup-macos-cdp.sh
```

> Opciones: `--no-auto` omite el inicio automático (`ag-context-meter install-launcher` crea un lanzador opcional en `~/Applications`) y `--no-remote` desactiva el servidor remoto. En Windows / Linux puedes iniciar Antigravity con depuración remota y ejecutar `node cli.js live`.

### Comandos diarios

- `ag-context-meter status`: comprueba los módulos activos y la integridad oficial de `app.asar`.
- `ag-context-meter remote`: muestra el QR de los 4 canales y dispositivos conectados (`--tunnel on|off`, `--reset-token`).
- `ag-context-meter live` / `restart`: inyecta al instante o reinicia con puerto CDP habilitado (`v2.33.0+`).
- `ag-context-meter update` / `stop` / `auto-off`: actualiza en caliente, detiene la sesión actual o desactiva el arranque automático.

Ejecuta `npm run test:suite` para correr las pruebas. Para la guía completa, solución de problemas y créditos de código abierto, consulta el **[README en chino simplificado](README.md)** o el **[README en inglés](README.en.md)**. Bajo licencia [MIT License](LICENSE).
