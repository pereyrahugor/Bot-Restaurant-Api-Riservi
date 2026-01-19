# Reiniciar Bot (Railway) 🔄

Este endpoint permite solicitar el reinicio forzado del despliegue activo directamente en la plataforma de Railway.

## Definición Técnica
* **Método**: `POST`
* **Ruta**: `/api/restart-bot`

## Requerimientos
- La variable `RAILWAY_TOKEN` debe ser válida.
- Las variables `RAILWAY_PROJECT_ID` y `RAILWAY_SERVICE_ID` deben estar configuradas.

## Respuesta

```json
{
  "success": true,
  "message": "Reinicio solicitado correctamente."
}
```

## Gestión de Errores
| Error | Causa |
| :--- | :--- |
| `500 Internal Server Error` | Fallo en la comunicación con la API de Railway o falta de credenciales. |

---
> **Nota**: Este endpoint es útil para aplicar cambios de variables de entorno o para recuperar el bot de estados de bloqueo sin intervención manual en el panel de Railway.
