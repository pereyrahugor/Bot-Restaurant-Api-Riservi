# Flujo de Bienvenida 👋

El flujo de bienvenida es el punto de entrada principal para cualquier interacción iniciada por un usuario, ya sea por texto, voz o imagen.

## Definición Funcional
Este flujo se activa automáticamente cuando un usuario envía un mensaje fuera de una sesión activa (Evento `WELCOME`). Su objetivo es procesar el mensaje, gestionar la cola de peticiones y delegar la lógica inteligente a OpenAI.

## Variantes del Flujo
1. **Texto (`welcomeFlowTxt`)**: Procesa mensajes de texto convencionales.
2. **Voz (`welcomeFlowVoice`)**: Gestiona notas de voz, delegando la transcripción a OpenAI.
3. **Imagen (`welcomeFlowImg`)**: Procesa imágenes enviadas por el usuario.

## Lógica Interna
- **Gestión de Colas**: Para evitar colisiones en la API de OpenAI, el bot implementa un sistema de cola (`userQueues`) y bloqueos (`userLocks`) por cada usuario (`ctx.from`).
- **Temporizador de Inactividad**: Al entrar en este flujo, se reinicia un temporizador de inactividad basado en la variable `timeOutCierre`.
- **Integración con Asistente**: El mensaje del usuario se envía a la función `processUserMessage`, la cual:
  1. Muestra el estado "escribiendo" en WhatsApp.
  2. Solicita una respuesta al Asistente de OpenAI.
  3. Ejecuta herramientas (functions) si el asistente lo requiere (ej: `checkAvailability`).
  4. Responde al usuario con el texto generado.

## Ejemplo de Proceso
1. **Usuario**: "Hola, quiero reservar una mesa para mañana a las 20:00."
2. **Bot**: (Encola el mensaje) -> Activa `typing` -> (Consulta OpenAI) -> (OpenAI llama a `checkAvailability`).
3. **Bot**: "¡Hola! Sí, tenemos disponibilidad para mañana a las 20:00 para 2 personas. ¿Te gustaría confirmar la reserva?"

---
**Ver También**:
- [Flujo de Inactividad](idle-flow.md)
