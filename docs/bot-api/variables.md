# Gestión de Variables ⚙️

Esta interfaz permite visualizar y modificar las variables de entorno configuradas en Railway directamente desde el dashboard del bot.

## Definición Técnica
* **Método Interfaz**: `GET`
* **Ruta Interfaz**: `/variables`
* **API Obtener**: `GET /api/variables`
* **API Actualizar**: `POST /api/update-variables`

## Funcionalidades
1.  **Visualización**: Muestra una lista de variables de entorno clave (excluyendo secretos sensibles si así se configura).
2.  **Edición**: Permite modificar los valores de las variables como `OPENAI_API_KEY`, `ASSISTANT_ID`, Prompts, entre otros.
3.  **Reinicio Automático**: Al guardar los cambios, el sistema solicita automáticamente un reinicio del servicio en Railway para aplicar la nueva configuración.

## Endpoints de API Relacionados

### Obtener Variables
Retorna el objeto JSON con las variables actuales.
- **URL**: `/api/variables`
- **Método**: `GET`
- **Respuesta Exitosa**:
  ```json
  {
    "success": true,
    "variables": {
      "PORT": "3000",
      "ASSISTANT_ID": "asst_..."
    }
  }
  ```

### Actualizar Variables
Actualiza las variables en Railway y reinicia el servicio.
- **URL**: `/api/update-variables`
- **Método**: `POST`
- **Body**:
  ```json
  {
    "variables": {
      "KEY_NAME": "NEW_VALUE"
    }
  }
  ```
- **Respuesta Exitosa**:
  ```json
  {
    "success": true,
    "message": "Variables actualizadas y reinicio solicitado."
  }
  ```

---
**Nota**: Esta funcionalidad depende de la integración con la API de Railway y requiere que las credenciales (`RAILWAY_TOKEN`, etc.) estén correctamente configuradas.
