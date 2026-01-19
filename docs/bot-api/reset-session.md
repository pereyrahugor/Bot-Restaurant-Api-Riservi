# Reiniciar Sesión 🗑️

Este endpoint permite desconectar el bot, eliminar todos los archivos de sesión y preparar el sistema para un nuevo escaneo de WhatsApp.

## Definición Técnica
* **Método**: `POST`
* **Ruta**: `/api/reset-session`

## Proceso de Ejecución
1. **Limpieza Local**: Elimina la carpeta `bot_sessions` y el archivo `bot.qr.png`.
2. **Limpieza Remota**: Llama a `deleteSessionFromDb()` para borrar los datos persistidos en Supabase.
3. **Reinicio de Proceso**: Envía un comando de salida (`process.exit(0)`) permitiendo que el orquestador (Railway o Docker) reinicie el contenedor.

## Respuestas

| Formato | Contenido |
| :--- | :--- |
| `application/json` | `{"success": true, "message": "Sesión eliminada. Reiniciando..."}` |
| `text/html` | Una página de confirmación con un temporizador para recargar el dashboard. |

## Uso Sugerido
Utilice este endpoint solo cuando el bot ya no responda o necesite cambiar la cuenta de WhatsApp vinculada.

---
**Advertencia**: Esta acción es destructiva y requiere un nuevo escaneo físico por parte del administrador.
