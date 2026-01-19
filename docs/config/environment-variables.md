# Variables de Entorno ⚙️

Este documento describe todas las variables de entorno necesarias para el correcto funcionamiento del bot.

## Lista de Variables

| Variable | Descripción | Ejemplo / Fuente |
| :--- | :--- | :--- |
| `ASSISTANT_ID` | ID del Asistente de OpenAI configurado. | `asst_...` |
| `OPENAI_API_KEY` | Llave de API de OpenAI para el asistente. | `sk-proj-...` |
| `RESERVI_API_KEY` | Token de autorización para la API de Riservi. | `PROD-...` o `DEV-...` |
| `ASSISTANT_NAME` | Nombre descriptivo del asistente (usado en logs/UI). | `Asistente Riservi` |
| `PORT` | Puerto donde correrá el servidor web. | `3008` o `8080` |
| `RAILWAY_PROJECT_ID` | ID del proyecto en Railway (usado para reinicios). | UUID |
| `RAILWAY_TOKEN` | Token de API de Railway. | `...` |
| `RAILWAY_SERVICE_ID` | ID del servicio específico en Railway. | UUID |
| `SUPABASE_URL` | URL del proyecto Supabase para persistencia. | `https://...` |
| `SUPABASE_KEY` | Service Role Key o Anon Key de Supabase. | JWT |
| `ID_GRUPO_RESUMEN` | ID del grupo de WhatsApp para reportes de errores. | `12345678@g.us` |
| `timeOutCierre` | Tiempo en minutos para el flujo de inactividad. | `20` |

---

## Cómo Obtenerlas

### OpenAI
1. Accede a [OpenAI Platform](https://platform.openai.com/assistants).
2. Crea un asistente y copia su `ASSISTANT_ID`.
3. Genera una API Key en la sección de [API Keys](https://platform.openai.com/api-keys).

### Riservi
Solicita tus credenciales de Partner a través del equipo de soporte de Riservi para obtener tu `RESERVI_API_KEY`.

### Supabase
Crea un proyecto en [Supabase](https://supabase.com/) y obtén las credenciales en `Project Settings > API`. Es necesario que el proyecto tenga una tabla para el manejo de sesiones si se usa `sessionSync.ts`.

### Railway
Si despliegas en Railway, estas variables se pueden configurar en la pestaña **Variables** del servicio. Los IDs de proyecto y servicio se encuentran en la URL del dashboard de Railway.

> **Aviso**: Nunca compartas tu archivo `.env` ni expongas estas llaves en repositorios públicos.
