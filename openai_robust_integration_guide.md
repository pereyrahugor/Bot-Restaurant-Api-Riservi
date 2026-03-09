# Guía de Implementación: Reconexión Robusta y Gestión de Runs en OpenAI Assistants

Esta guía detalla la lógica y el código necesarios para implementar una integración resiliente con la API de OpenAI Assistants, abordando específicamente el error recurrente `400 Can't add messages to thread while a run is active` y asegurando la entrega de reportes/resúmenes.

## 1. Problema: El Hilo Bloqueado
Cuando varias peticiones (`webhooks`) llegan casi simultáneamente o un proceso (`run`) queda en estado `requires_action` sin respuesta, OpenAI bloquea el hilo (`thread`). Intentar enviar un mensaje resulta en un error 400.

## 2. Solución: Estrategia de 3 Capas

### Capa 1: Verificación Proactiva (`waitForActiveRuns`)
Antes de cada llamada, verificamos si el hilo tiene procesos activos.

```typescript
export async function waitForActiveRuns(threadId: string, maxAttempts = 5) {
    try {
        let attempt = 0;
        while (attempt < maxAttempts) {
            const runs = await openai.beta.threads.runs.list(threadId);
            const activeRun = runs.data.find(r => 
                ['in_progress', 'queued', 'requires_action'].includes(r.status)
            );

            if (activeRun) {
                console.log(`[Reconexión] Run activo detectado (${activeRun.status}): ${activeRun.id}`);
                // Si está estancado en requires_action, lo cancelamos proactivamente
                if (activeRun.status === 'requires_action' && attempt >= 2) {
                    await openai.beta.threads.runs.cancel(threadId, activeRun.id);
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 2000));
                attempt++;
            } else {
                return;
            }
        }
    } catch (error) {
        console.error(`Error verificando runs:`, error);
    }
}
```

### Capa 2: Petición Segura con Reintentos (`safeToAsk`)
Envolvemos `toAsk` en una función que maneja reintentos y captura el `run_id` directamente del error de la API para cancelarlo.

```typescript
export const safeToAsk = async (
  assistantId: string,
  message: string,
  state: any,
  userId: string,
  errorReporter?: any,
  maxRetries = 5
) => {
  let attempt = 0;
  while (attempt < maxRetries) {
    const threadId = state.get('thread_id');
    if (threadId) await waitForActiveRuns(threadId);

    try {
      return await toAsk(assistantId, message, state);
    } catch (err: any) {
      attempt++;
      const errorMessage = err?.message || String(err);

      // Si OpenAI nos dice qué run está bloqueando, lo cancelamos de inmediato
      if (errorMessage.includes('while a run') && errorMessage.includes('is active') && threadId) {
        const runIdMatch = errorMessage.match(/run_[a-zA-Z0-9]+/);
        if (runIdMatch) {
          await openai.beta.threads.runs.cancel(threadId, runIdMatch[0]);
          await new Promise(r => setTimeout(r, 3000));
          continue; // Reintento inmediato
        }
      }

      if (attempt >= maxRetries) {
          // CAPA 3: Renovación de Hilo (Ver abajo)
          return await renewThreadAndRetry(assistantId, message, state, userId, errorReporter);
      }
      
      await new Promise(r => setTimeout(r, attempt * 2000));
    }
  }
};
```

### Capa 3: Renovación Automática de Hilo
Si tras los reintentos el hilo sigue bloqueado, recuperamos los últimos mensajes de nuestra base de datos (Supabase) y creamos un hilo nuevo para no perder al usuario.

**Crítico: Obtener los mensajes correctos**
```typescript
// En HistoryHandler.ts
static async getMessages(chatId: string, limit: number = 10) {
    const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('chat_id', chatId)
        .order('created_at', { ascending: false }) // Primero los más nuevos
        .limit(limit);
    
    return (data || []).reverse(); // Invertir para orden cronológico
}
```

**Lógica de Renovación:**
```typescript
async function renewThreadAndRetry(...) {
    // 1. Notificar al desarrollador por WhatsApp
    await errorReporter.reportError("Hilo bloqueado. Renovando...", userId);

    // 2. Traer el historial reciente (ej. últimos 10 mensajes)
    const history = await HistoryHandler.getMessages(userId, 10);
    
    // 3. Crear nuevo hilo en OpenAI con ese contexto
    const newThread = await openai.beta.threads.create({
        messages: history.map(m => ({ role: m.role, content: m.content }))
    });

    // 4. Actualizar estado y reintentar
    await state.update({ thread_id: newThread.id });
    return await toAsk(assistantId, message, state);
}
```

## 3. Funcionamiento de Reportes (`idleFlow`)
Para asegurar que los resúmenes lleguen al grupo tras periodos de inactividad (donde es más probable encontrar runs caducados o hilos perdidos):

1.  Usar siempre `safeToAsk` en lugar de `toAsk`.
2.  Pasar el `errorReporter` para tener visibilidad de fallos.
3.  Implementar logs de "paso a paso".

```typescript
const idleFlow = addKeyword(EVENTS.ACTION).addAction(
    async (ctx, { state }) => {
        const resumen = await safeToAsk(ASSISTANT_ID, "GET_RESUMEN", state, ctx.from, errorReporter);
        
        if (!resumen) return; // Manejar error

        const data = extraerDatosResumen(resumen);
        if (data.tipo === 'SI_RESUMEN') {
            await sendToGroup(ID_GRUPO_RESUMEN, resumen);
        }
    }
);
```

## 4. Ventajas de este Diseño
*   **Resiliencia**: El bot no se "cuelga" si OpenAI falla; se repara solo.
*   **Continuidad**: Al renovar el hilo con el historial de Supabase, el usuario no nota el cambio.
*   **Transparencia**: El equipo recibe alertas proactivas cuando un hilo tuvo que ser renovado.
*   **Orden**: Centraliza la inteligencia de comunicación en un solo punto (`safeToAsk`).
