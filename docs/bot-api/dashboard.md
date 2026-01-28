# Dashboard Principal 📊

El dashboard principal es la interfaz web del bot, accesible vía navegador, que muestra el estado de la conexión de WhatsApp y ofrece herramientas básicas de control.

## Definición Técnica
* **Método**: `GET`
* **Ruta**: `/dashboard` (La ruta raíz `/` redirige aquí)

## Funcionalidades
1. **Estado de Sesión**: Indica si el bot tiene una sesión de WhatsApp activa o si está esperando ser vinculado.
2. **Visualización de QR**: Muestra el código QR dinámicamente si no hay sesión iniciada.
3. **Acceso a WebChat**: Botón directo para abrir la interfaz de chat web.
4. **Gestión de Variables**: Acceso al panel para modificar variables de entorno en tiempo real.
5. **Reseteo de Sesión**: Botón de "Zona de Peligro" para borrar las sesiones locales y remotas.

## Interfaz Visual
El dashboard utiliza un diseño moderno con las siguientes características:
- Colores representativos (`#008069` para éxito, `#dc3545` para peligro).
- Actualización automática de la página cada 5 segundos si está en modo escaneo.
- Diseño responsivo para móviles y escritorio.

## Ejemplo de Respuesta (HTML)
La respuesta es un documento HTML completo generado dinámicamente según el estado del servidor.

---
**Ver También**:
- [Imagen QR](qr-image.md)
- [Reiniciar Sesión](reset-session.md)
