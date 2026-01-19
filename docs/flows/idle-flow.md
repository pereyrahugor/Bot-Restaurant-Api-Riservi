# Flujo de Inactividad ⏳

El flujo de inactividad gestiona el cierre automático de las conversaciones cuando el usuario deja de responder por un periodo prolongado.

## Definición Funcional
Se activa cuando el temporizador de inactividad (`timeOutCierre`) llega a su fin. Su objetivo principal es generar un resumen de la conversación y realizar reportes administrativos antes de liberar los recursos de la sesión.

## Proceso de Cierre
1. **Generación de Resumen**: El bot envía el comando interno `GET_RESUMEN` al asistente de OpenAI.
2. **Clasificación**: Según la respuesta de la IA, el bot clasifica el cierre en uno de los siguientes tipos:
   - `SI_RESUMEN`: Envía un resumen detallado al grupo de WhatsApp administrativo (`ID_GRUPO_RESUMEN`) y lo guarda en un archivo Google Sheets.
   - `NO_REPORTAR_SEGUIR`: Intenta una reconexión automática antes de cerrar definitivamente.
   - `NO_REPORTAR_BAJA`: Cierra la conversación silenciosamente, solo registrando en Sheets.
3. **Cierre de Sesión**: Se invoca `endFlow()` para finalizar formalmente la interacción actual de BuilderBot.

## Datos del Resumen
El resumen extraído suele contener:
- **Nombre del Cliente**
- **Motivo de la Consulta**
- **Estado de la Reserva** (si aplica)
- **Link directo al chat de WhatsApp** para seguimiento humano.

---
**Nota**: El tiempo de espera es configurable mediante la variable de entorno `timeOutCierre` (especificado en minutos).

---
**Ver También**:
- [Variables de Entorno](../config/environment-variables.md)
