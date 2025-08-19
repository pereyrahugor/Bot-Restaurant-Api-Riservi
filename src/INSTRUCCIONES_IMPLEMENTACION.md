**INSTRUCCIONES PARA IMPLEMENTAR EL NUEVO CÓDIGO DE RESERVAS**

He creado un nuevo archivo `app.ts.new` que contiene una implementación completa del bot de reservas integrado con la API de Riservi. Para implementar estos cambios, sigue estos pasos:

1. **Haz una copia de seguridad de tu `app.ts` actual**:
   ```bash
   cp d:\Dev\Bot-Roldan\src\app.ts d:\Dev\Bot-Roldan\src\app.ts.backup
   ```

2. **Reemplaza tu archivo `app.ts` con el nuevo código**:
   ```bash
   cp d:\Dev\Bot-Roldan\src\app.ts.new d:\Dev\Bot-Roldan\src\app.ts
   ```

3. **Verifica que las dependencias estén instaladas**:
   ```bash
   npm install moment axios dotenv
   ```

4. **Comprueba tus variables de entorno**:
   Asegúrate de que tengas estas variables configuradas en tu archivo `.env`:
   ```
   PORT=3000
   ASSISTANT_ID=tu_id_de_asistente_openai
   ID_GRUPO_WS=tu_id_de_grupo_whatsapp
   RESERVI_API_KEY=tu_api_key_de_riservi
   ```

5. **Inicia el bot**:
   ```bash
   npm start
   ```

**CAMBIOS PRINCIPALES**:

1. **Integración con Riservi**:
   - El código ahora consulta la disponibilidad real a través de la API de Riservi
   - Maneja la creación de reservas mediante la API de Riservi
   - Muestra horarios alternativos cuando no hay disponibilidad

2. **Mejoras en el manejo de respuestas del asistente**:
   - Detecta bloques JSON especiales (#DISPONIBLE# y #RESERVA#)
   - Filtra los bloques JSON para no mostrarlos al usuario
   - Implementa un control de concurrencia para evitar errores de "run is active"

3. **Logging mejorado**:
   - Logs detallados de cada paso del proceso
   - Logs específicos para errores de API
   - Logs para debugging de JSON y respuestas

4. **Manejo de errores robusto**:
   - Manejo de timeouts
   - Reintentos automáticos
   - Mensajes de error claros para el usuario

**FLUJO DE RESERVA**:

1. El usuario proporciona fecha/hora y cantidad de personas
2. El asistente genera un bloque JSON con tipo #DISPONIBLE#
3. El bot consulta la disponibilidad real en la API de Riservi
4. Si hay disponibilidad, pide datos personales al usuario
5. Si no hay disponibilidad, muestra horarios alternativos
6. El usuario proporciona datos personales o elige un horario alternativo
7. El asistente genera un bloque JSON con tipo #RESERVA#
8. El bot crea la reserva en la API de Riservi
9. Muestra confirmación de reserva al usuario

**CONSEJOS PARA TESTING**:

1. Prueba primero con solicitudes simples de disponibilidad: "Quiero reservar para 4 personas mañana a las 20:00"
2. Verifica que el bot muestre los horarios alternativos correctamente
3. Prueba la selección de horarios alternativos
4. Prueba con datos personales completos para asegurar que la reserva se crea correctamente

Si encuentras algún problema, revisa los logs para identificar el punto exacto del error y ajusta el código según sea necesario.
