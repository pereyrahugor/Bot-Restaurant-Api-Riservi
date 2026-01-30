# Implementación de YCloud Provider (Meta API)

Esta guía detalla cómo implementar el proveedor `YCloudProvider` en otros repositorios de BuilderBot para conectar con la API oficial de WhatsApp a través de YCloud, eliminando la dependencia de la conexión por QR (Baileys) para la conversación principal.

## 1. Archivos Requeridos

Debes copiar el archivo `YCloudProvider.ts` en tu carpeta de proveedores (por ejemplo: `src/providers/`).

### Código del Provider (`src/providers/YCloudProvider.ts`)

Este adaptador hereda de `ProviderClass` y maneja:
*   El envío de mensajes vía HTTP POST a la API de YCloud.
*   La recepción de mensajes vía Webhook y su conversión a eventos de BuilderBot.

*(Puedes copiar el código fuente actual del archivo `src/providers/YCloudProvider.ts` de este repositorio).*

## 2. Variables de Entorno (.env)

Configura las siguientes variables en tu archivo `.env` y en tu plataforma de despliegue (Railway, Docker, etc.):

```env
# API Key generada en el panel de YCloud
YCLOUD_API_KEY=tu_api_key_aqui

# Tu número de WhatsApp Business activo en YCloud (WABA Number)
# Formato internacional sin + (ej: 5491122334455)
YCLOUD_WABA_NUMBER=54911xxxxxxxx

# URL base de tu proyecto desplegado (usado solo para imprimir logs de ayuda)
PROJECT_URL=https://tu-proyecto.up.railway.app
```

## 3. Modificaciones en `app.ts`

### Importar el Provider
```typescript
import { createProvider } from "@builderbot/bot";
import { YCloudProvider } from "./providers/YCloudProvider";
import { initGroupSender } from "./utils/groupSender"; // Si usas envíos a grupos
```

### Inicializar el Provider Principal (YCloud)
Reemplaza `BaileysProvider` (o cualquier otro) por `YCloudProvider`.

```typescript
const adapterProvider = createProvider(YCloudProvider, {});
```

### Configurar el Webhook
Debes exponer una ruta POST para recibir los mensajes de YCloud.

```typescript
const app = adapterProvider.server;

app.post('/webhook', (req, res) => {
    adapterProvider.handleWebhook(req, res);
});
```

### Inicialización de Provider Secundario (Grupos)
**Para repositorios que necesiten enviar mensajes a Grupos de WhatsApp:**
La API de Meta tiene restricciones para enviar mensajes a grupos. Por ello, mantenemos una instancia secundaria de Baileys exclusivamente para esta función.

1.  Copia el archivo `src/utils/groupSender.ts`.
2.  Importa e inicializa en `main()` (dentro de `app.ts`, antes de crear el bot):
    ```typescript
    await initGroupSender(); 
    ```
    *(Esto iniciará la sincronización de sesión y generará `bot.groups.qr.png` si es necesario).*
3.  **Importante al usar `groupProvider` en Flujos**:
    Para evitar problemas de instancias `undefined`, importa siempre el provider usando **rutas relativas** (ej: `../utils/groupSender`) y **no alias** (ej: evita `~/utils/groupSender` o `@/utils/groupSender` si tu transpilador no garantiza Singletons).
    
    Además, valida siempre la existencia del método antes de llamar:
    ```typescript
    import { groupProvider } from '../utils/groupSender';

    // ... dentro de tu acción ...
    if (groupProvider && typeof groupProvider.sendMessage === 'function') {
        await groupProvider.sendMessage(ID_GRUPO_RESUMEN, mensaje, {});
    } else {
        console.error("Provider de Grupos no disponible");
    }
    ```

## 4. Reportes de Alta Fiabilidad (Reporte Premium)

Debido a las inestabilidades de las librerías basadas en QR (Baileys) para el envío a grupos (errores de `No sessions` o `MAC failure`), la mejor práctica actual es enviar los reportes/resúmenes directamente a un número de WhatsApp administrativo utilizando la **API Oficial (YCloud)**.

### Configuración del Reporte:
1.  **Variable de Entorno**: Define `ID_GRUPO_RESUMEN` con el número de teléfono del administrador.
    *   Formato: Código de país + Código de área + Número (ej: `5491130792789`).
    *   **NO** usar `@s.whatsapp.net` ni símbolos como `+`.
2.  **Uso en Flujos**: El bot detectará automáticamente que el destino es un número y usará la API oficial, garantizando un 100% de entrega.

---

## 5. Filtro de Seguridad contra Bucles Infinitos (Eco Filter)

Al usar APIs oficiales (YCloud/Meta), es frecuente recibir un webhook de "confirmación de envío" que el bot puede interpretar erróneamente como un mensaje entrante de un nuevo usuario. Si este mensaje por error activa un flujo (como el `idleFlow`), se generará un **bucle infinito de mensajes cada 10-15 minutos**.

### Implementación Obligatoria en `app.ts`:
Debes filtrar los mensajes cuyo remitente sea el mismo número del bot antes de procesarlos:

```typescript
export const processUserMessage = async (ctx, { flowDynamic, state, provider, gotoFlow }) => {
  const userId = ctx.from;
  const botNumber = (process.env.YCLOUD_WABA_NUMBER || '').replace(/\D/g, '');
  
  // FILTRO DE SEGURIDAD: Evitar que el bot procese su propio eco
  if (userId.replace(/\D/g, '') === botNumber) {
      const { stop } = await import('./utils/timeOut');
      stop(ctx); // Detiene cualquier timer de inactividad preventivamente
      return;
  }
  // ... resto de la lógica
```

---

## 6. Buenas Prácticas en `idleFlow`

Para asegurar que los resúmenes de reserva sean limpios y los estados del bot se cierren correctamente:

1.  **Cierre de Estado**: Siempre utiliza `return endFlow()` al finalizar el envío de un resumen. Esto previene que el bot mantenga un estado de conversación "fantasma" que reactive el temporizador innecesariamente.
2.  **Limpieza de Enlaces**: Si usas IA para generar el resumen, esta puede inventar enlaces `wa.me`. Limpia el texto antes de pegarle el enlace real generado por el bot:
    ```typescript
    const resumenLimpio = resumen.replace(/https:\/\/wa\.me\/[0-9]+/g, '').trim();
    const resumenConLink = `${resumenLimpio}\n\n🔗 [Chat](${data.linkWS})`;
    ```
3.  **linkWS Robusto**: Asegúrate de que el enlace de WhatsApp al usuario se genere desde el `ctx.from` (o número del cliente real) y nunca desde el número del bot o del reporte.

---

## 7. Configuración en YCloud

1.  Accede a tu cuenta en [YCloud Console](https://console.ycloud.com).
2.  Ve a **WhastApp** > **Integration** (o Webhooks).
3.  En **Webhook URL**, ingresa la URL completa de tu bot:
    `https://tu-proyecto.up.railway.app/webhook`
4.  Asegúrate de marcar los eventos (events) a los que te quieres suscribir, principalmente:
    *   `whatsapp.inbound_message.received` (o `messages` en la config de Meta).
5.  Guarda los cambios.

## 8. Verificación

Al iniciar tu bot, deberías ver en la consola un mensaje indicando la URL del webhook si configuraste `PROJECT_URL`:

```
✅ YCloud Webhook URL (Configurar en Panel): https://tu-proyecto.up.railway.app/webhook
```

Al enviar un mensaje a tu número de WhatsApp, el bot debería recibirlo a través del webhook y procesarlo con el flujo configurado.

Si usas el Provider de Grupos, verás logs adicionales:
```
🔌 [GroupSender] Iniciando Proveedor Baileys secundario para Grupos...
✅ [GroupSender] Provider de Grupos conectado y listo.
```
Si el filtro de seguridad está activo y un mensaje de eco llega, verás en la consola:
```
🛑 [Security] Mensaje de eco detectado desde el número del bot. Ignorando.
```
