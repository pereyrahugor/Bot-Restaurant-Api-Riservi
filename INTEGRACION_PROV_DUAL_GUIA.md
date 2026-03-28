# Guía de Integración Dual de Proveedores (YCloud + Baileys)

Esta guía detalla cómo realizar la convivencia de dos proveedores en un mismo bot de BuilderBot: **YCloud** (para mensajes individuales oficiales) y **Baileys/Sherpa** (para mensajes grupales o notificaciones).

## Arquitectura General

En BuilderBot, `createBot` solo acepta **un** proveedor principal (Active Provider). Toda la lógica de flujos (`createFlow`) se asocia a este proveedor. El segundo proveedor (Standby Provider) se inicializa manualmente y se mantiene "vivo" para realizar tareas específicas, como el envío de resúmenes a grupos.

---

## 1. Registro de Instancias
**Ubicación:** `src/providers/instances.ts`

Este archivo es el "puente" que permite acceder a ambos proveedores desde cualquier parte del código (flujos, utilidades, etc.) sin crear ciclos de dependencia.

### Funciones y Variables:
- `adapterProvider`: Almacena la instancia de **YCloud** (WhatsApp Business API). Se utiliza para la interacción 1:1 con el usuario.
- `groupProvider`: Almacena la instancia de **Baileys** (vía `builderbot-provider-sherpa`). Se utiliza exclusivamente para interacciones con grupos de WhatsApp (donde YCloud no llega).
- `setAdapterProvider(p)` / `setGroupProvider(p)`: Funciones "setter" utilizadas en `app.ts` para guardar las instancias una vez creadas.

---

## 2. Inicialización en el Punto de Entrada
**Ubicación:** `src/app.ts` (dentro de la función `main`)

Aquí es donde ocurre la magia de la coexistencia.

### Flujo de Ejecución:
1. **Inicializar YCloud (Principal):**
   ```typescript
   setAdapterProvider(createProvider(YCloudProvider, {}));
   ```
   Se crea el proveedor que recibirá los mensajes de los usuarios.

2. **Inicializar Baileys (Grupos):**
   ```typescript
   setGroupProvider(createProvider(BaileysProvider, {
       groupsIgnore: false, // Permitir que el motor vea grupos
       disableHttpServer: true // IMPORTANTE: Solo un provider debe manejar el servidor HTTP
   }));
   ```
   *Nota:* Se usa `disableHttpServer: true` para que no intente levantar un segundo puerto en la misma app.

3. **Creación del Bot:**
   ```typescript
   const { httpServer } = await createBot({
       flow: adapterFlow,
       provider: adapterProvider, // Solo pasamos el principal aquí
       database: adapterDB,
   });
   ```

4. **Tráfico de Webhooks:**
   Como YCloud funciona con webhooks, debemos delegar el tráfico manualmente:
   ```typescript
   app.post('/webhook', (req, res) => {
       res.status(200).send('OK'); // Respuesta rápida a Meta
       adapterProvider.handleWebhook(req, res); // Pasar el payload al proveedor
   });
   ```

---

## 3. Discriminador de Envíos (El Switch)
**Ubicación:** `src/utils/groupSender.ts`

Esta es la función que decide qué "cañería" usar según el destinatario.

### Función: `sendToGroup(target, message)`
- **Para qué:** Centraliza todos los envíos que podrían ir a un grupo.
- **Lógica:**
  - Si `target.includes('@g.us')`: Llama a `groupProvider.sendMessage()`. Esto usa la conexión de Baileys (escaneo de QR).
  - Si NO contiene `@g.us`: Significa que es un número individual. Llama a la API de YCloud.

```typescript
export const sendToGroup = async (target, message) => {
    if (target.includes('@g.us')) {
        // Enviar vía motor de grupos (Baileys)
        await groupProvider.sendMessage(target, message, {});
    } else {
        // Enviar vía canal oficial (YCloud API)
        await sendViaYCloud(target, message);
    }
};
```

---

## 4. Uso en los Flujos
**Ubicación:** `src/Flows/idleFlow.ts` (u otros flujos de cierre)

Cuando el bot termina de atender a un usuario y quiere reportar el resumen de la venta/reserva a un grupo de la empresa:

1. Se importa la función `sendToGroup`.
2. Se le pasa el `ID_GRUPO_RESUMEN` (configurado en `.env`).
3. El sistema detecta que el ID termina en `@g.us` y utiliza automáticamente el motor de Baileys para enviar el mensaje, sin interrumpir la sesión oficial de YCloud del usuario.

---

## 5. Resumen de Ubicaciones y Responsabilidades

| Archivo | Elemento | Responsabilidad |
| :--- | :--- | :--- |
| `src/providers/instances.ts` | `adapterProvider` / `groupProvider` | Almacenamiento global de las conexiones. |
| `src/app.ts` | `main()` | Configura e instancia ambos proveedores. Conecta los webhooks. |
| `src/providers/YCloudProvider.ts` | `handleWebhook()` | Traduce los datos que llegan de Meta/YCloud al formato de BuilderBot. |
| `src/utils/groupSender.ts` | `sendToGroup()` | Detecta si un mensaje es para grupo o individual y elige el proveedor a usar. |
| `src/Flows/idleFlow.ts` | Uso de `sendToGroup` | Disparador final que envía la información al grupo al cerrar sesión. |

## Consejos para el Refactor
1. **No mezcles flujos:** Solo asigna flujos al proveedor que recibe a los humanos (YCloud). Deja el de grupos "huérfano" (`on('message')` vacío) para evitar que el bot intente responder en los grupos de la empresa.
2. **Sincronización de Sesión:** Asegúrate de que el motor de grupos persista su sesión (QR) en una base de datos (como Supabase) para que no pida escanear el código cada vez que reinicias el servidor.
3. **Variables de Entorno:** Mantén separados `YCLOUD_API_KEY` y los IDs de los grupos de reporte para evitar confusiones.

---
*Documentación generada para la implementación en el nuevo repositorio refactorizado.*
