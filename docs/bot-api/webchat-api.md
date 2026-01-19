# WebChat API 💬

Proporciona el backend para la comunicación entre la interfaz de chat web y el bot, utilizando tanto HTTP como WebSockets (Socket.IO).

## Endpoint HTTP
* **Metodo**: `POST`
* **Ruta**: `/webchat-api`

### Parámetros de Entrada
| Parámetro | Tipo | Descripción |
| :--- | :--- | :--- |
| `message` | `string` | El mensaje enviado por el usuario desde la web. |

### Respuesta
```json
{
  "reply": "Hola, ¿en qué puedo ayudarte hoy?"
}
```

## Socket.IO (Evento `message`)
El bot escucha conexiones persistentes para una experiencia de chat en tiempo real.

- **Evento Recibido**: `message` (string)
- **Evento Emitido**: `reply` (string)

## Funcionalidades Especiales
- **#reset / #cerrar**: Si el usuario envía estos comandos, la sesión de chat (Thread de OpenAI) se elimina y el historial se limpia.
- **Detección de IP**: Se utiliza la dirección IP del cliente para segmentar las sesiones de chat y los historiales.

---
**Ver También**:
- [Dashboard Principal](dashboard.md)
