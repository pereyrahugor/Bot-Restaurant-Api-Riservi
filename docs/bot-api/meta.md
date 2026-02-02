# Implementación de Sistema Dual: YCloud (Principal) y Baileys (Grupos)

Este documento detalla cómo logramos la convivencia de la API Oficial (YCloud/Meta) para conversaciones individuales y el motor Baileys para el envío de reportes a grupos de WhatsApp, integrando persistencia en la nube.

## 1. Arquitectura de Proveedores

Para superar las limitaciones de la API oficial con respecto a los grupos, configuramos dos proveedores en `app.ts`:

*   **`adapterProvider` (YCloudProvider)**: Maneja el 100% de la mensajería individual y los flujos entrantes.
*   **`groupProvider` (BaileysProvider)**: Un motor secundario dedicado exclusivamente a interactuar con grupos de WhatsApp (donde la API oficial no llega o es limitada).

### Configuración en `app.ts`

```typescript
// ... imports
import { YCloudProvider } from "./providers/YCloudProvider";
import { BaileysProvider } from "builderbot-provider-sherpa";

export let adapterProvider;
export let groupProvider;

const main = async () => {
    // 1. Restaurar sesión de grupos ANTES de inicializar
    await restoreSessionFromDb('groups');

    // 2. Inicializar YCloud (Principal)
    adapterProvider = createProvider(YCloudProvider, {});

    // 3. Inicializar Baileys (Grupos)
    groupProvider = createProvider(BaileysProvider, {
        version: [2, 3000, 1030817285],
        groupsIgnore: false,
        readStatus: false,
        disableHttpServer: true
    });

    // 4. Iniciar Sincronización de Sesión (Supabase)
    startSessionSync('groups'); 
    
    // ... resto de la lógica de creación del bot
}
```

## 2. Persistencia de Sesión con Supabase

Para evitar perder la conexión de los grupos en cada despliegue (entornos efímeros como Railway), implementamos un sistema de sincronización en `src/utils/sessionSync.ts`:

*   **Restauración**: `restoreSessionFromDb('groups')` descarga los archivos `creds.json` y archivos de estado desde Supabase a la carpeta local `bot_sessions/`.
*   **Sincronización**: `startSessionSync('groups')` realiza un "checkpoint" a los 30s, 2m y luego cada hora, subiendo un backup comprimido (JSON) a Supabase.

### Archivos clave:
*   `src/utils/sessionSync.ts`: Contiene la lógica de `upsert` y `restore` usando el cliente de Supabase.

## 3. Captura de QR para Grupos

Dado que el `groupProvider` es secundario y no maneja el servidor HTTP principal, implementamos listeners específicos en `app.ts` para capturar el QR y guardarlo como imagen:

```typescript
const handleQR = async (qrString: string) => {
    if (qrString) {
        const qrPath = path.join(process.cwd(), 'bot.groups.qr.png');
        await QRCode.toFile(qrPath, qrString, { scale: 10, margin: 2 });
        console.log(`✅ [GroupSync] QR guardado en ${qrPath}`);
    }
};

groupProvider.on('require_action', async (payload) => {
    const qr = (typeof payload === 'string') ? payload : (payload?.qr || payload?.code);
    await handleQR(qr);
});
// También escuchamos eventos 'qr' y 'auth_require' por redundancia.
```

## 4. Implementación en `IdleFlow` (Selección de Provider)

La magia ocurre en los flujos. El bot debe decidir qué "brazo" usar para enviar el mensaje. 

### Lógica de selección (`src/Flows/idleFlow.ts`):

```typescript
import { groupProvider } from '../app';

async function sendMediaToGroup(provider: any, state: any, targetGroup: string, data: any) {
    // Detectamos si el destino es un grupo oficial (@g.us)
    const isOfficialGroup = targetGroup.includes('@g.us');
    
    // Si es grupo, usamos groupProvider (Baileys); si no, usamos provider (YCloud)
    const activeProvider = isOfficialGroup ? groupProvider : provider;

    if (activeProvider) {
        await activeProvider.sendMessage(targetGroup, "Mensaje", { media: "ruta/archivo" });
    }
}
```

### Detalle detallado del flujo:
1.  **Contexto**: El usuario termina una conversación.
2.  **ID Destino**: El bot tiene variables como `ID_GRUPO_RESUMEN` (que puede ser un número individual o un ID de grupo `@g.us`).
3.  **Acción**: Se verifica si el ID contiene `@g.us`.
4.  **Ejecución**:
    *   Si **SÍ** es grupo: Se usa la instancia exportada de `groupProvider`.
    *   Si **NO** es grupo: Se usa el `provider` inyectado por BuilderBot (YCloud).

## 5. Corrección de Identificadores (YCloud)

Para asegurar que el asistente mantenga el contexto correcto mientras el proveedor usa el identificador técnico:

*   **`wa_id`**: Utilizado para la entrega de mensajes física (campo `from` en el provider).
*   **`phoneNumber`**: Utilizado para el contexto de OpenAI (evita problemas con números de Brasil o cambios de formato).

En `YCloudProvider.ts`:
```typescript
const formatedMessage = {
    // ...
    from: msg.waId || msg.from.replace('+', ''), // Para el motor de BuilderBot
    phoneNumber: msg.from.replace('+', ''),       // Para nuestra lógica de contexto
    // ...
};
```

En `app.ts`:
```typescript
const contextId = ctx.phoneNumber || ctx.from;
const response = await getAssistantResponse(..., contextId, ...);
```

## 6. Portabilidad a otro Repositorio

Para replicar esto en otro proyecto, necesitas:

1.  **Copiar Proveedores**: `src/providers/YCloudProvider.ts`.
2.  **Copiar Utils**: `src/utils/sessionSync.ts` y configurar las tablas en Supabase.
3.  **Configurar `app.ts`**:
    *   Exportar ambos providers.
    *   Configurar los listeners de QR para el provider secundario.
    *   Importar y ejecutar `restoreSessionFromDb` y `startSessionSync`.
4.  **Adaptar Flujos**:
    *   Importar `groupProvider` desde `app`.
    *   Implementar la lógica de discriminación `isOfficialGroup`.
5.  **Variables de Entorno**:
    *   `YCLOUD_API_KEY`, `YCLOUD_WABA_NUMBER`.
    *   `SUPABASE_URL`, `SUPABASE_KEY`.
    *   `ID_GRUPO_RESUMEN` (Asegúrate de que incluya `@g.us` si es para Baileys).

---
*Nota: Siempre usa `instanceof` o chequeos de tipo al llamar a `groupProvider` para evitar errores si el motor secundario aún no ha sincronizado.*
