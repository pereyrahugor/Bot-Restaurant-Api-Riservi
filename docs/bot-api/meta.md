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
2.  Importa e inicializa en `main()`:
    ```typescript
    await initGroupSender(); 
    ```
    *(Esto iniciará la sincronización de sesión y generará `bot.groups.qr.png` si es necesario).*

## 4. Configuración en YCloud

1.  Accede a tu cuenta en [YCloud Console](https://console.ycloud.com).
2.  Ve a **WhastApp** > **Integration** (o Webhooks).
3.  En **Webhook URL**, ingresa la URL completa de tu bot:
    `https://tu-proyecto.up.railway.app/webhook`
4.  Asegúrate de marcar los eventos (events) a los que te quieres suscribir, principalmente:
    *   `whatsapp.inbound_message.received` (o `messages` en la config de Meta).
5.  Guarda los cambios.

## 5. Verificación

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
