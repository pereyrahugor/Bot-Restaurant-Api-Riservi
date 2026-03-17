# Documentación: Integración de OpenAI Tools (Function Calling) en Nuevos Bots

Este documento detalla los pasos y el código necesario para integrar nativamente el sistema de llamadas a herramientas (**Tool Call / Function Calling**) de OpenAI en cualquier nueva versión u otro proyecto basado en BuilderBot que utilice la API de Asistentes.

La transición elimina la dependencia de parsear cadenas de texto mágicas como `[API ...]` del mensaje del bot y en su lugar permite que OpenAI decida autónomamente cuándo interrumpir su respuesta de texto para solicitarle a nuestro código que ejecute una operación de bases de datos/API local, y espere su resultado de forma nativa.

---

## 1. El reemplazo de la función base \`toAsk\`

Por defecto, la función `toAsk` exportada por el plugin `@builderbot-plugins/openai-assistants` no procesa el estado `requires_action` responsable de las herramientas; fallará o se quedará colgado sin retornar respuesta porque necesita que alguien devuelva o inyecte los outputs de dichas herramientas.

Para todo nuevo proyecto, el primer paso es **dejar de utilizar `toAsk` localmente** y en su lugar emplear una versión avanzada a la cual le pasaremos el hilo y que se encargará de realizar de intermediario entre la LLM y tus funciones lógicas:

Copia y pega la siguiente función `askWithFunctions` en el módulo que haga tus consultas al asistente (ej. `AssistantResponseProcessor.ts`):

```typescript
import { openai } from '@builderbot-plugins/openai-assistants';
import OpenAI from "openai";

export const askWithFunctions = async (assistantId: string, message: string, state: any): Promise<string> => {
    let threadId = state && typeof state.get === 'function' ? state.get('thread_id') : null;
    
    // 1. Obtiene o crea el Thread
    if (!threadId) {
        const thread = await openai.beta.threads.create();
        threadId = thread.id;
        if (state && typeof state.update === 'function') {
            await state.update({ thread_id: threadId });
        }
    }

    // 2. Envía el mensaje del usuario al Thread
    await openai.beta.threads.messages.create(threadId, {
        role: "user",
        content: message
    });

    // Función recursiva que evalúa el estado de la comunicación iterativamente
    const handleRunStatus = async (run: OpenAI.Beta.Threads.Runs.Run): Promise<string> => {
        // A) OpenAI completó la respuesta generativa en modo "Respuesta de Texto"
        if (run.status === 'completed') {
            const messages = await openai.beta.threads.messages.list(run.thread_id);
            const latestMessage = messages.data.filter(m => m.role === 'assistant')[0];
            return latestMessage && latestMessage.content[0].type === 'text' ? latestMessage.content[0].text.value : '';
        } 
        
        // B) OpenAI entró en modo Tool Call (Function Calling) y necesita que procesemos la lógica localmente
        else if (run.status === 'requires_action') {
            const toolCalls = run.required_action?.submit_tool_outputs?.tool_calls;
            if (!toolCalls) return '';

            // Ejecutar en paralelo todas las funciones que nos pidió la IA
            const toolOutputs = await Promise.all(toolCalls.map(async (toolCall: any) => {
                const funcName = toolCall.function.name;
                let args = {};
                try {
                    args = JSON.parse(toolCall.function.arguments || "{}");
                } catch (e) {
                     console.error(`[FunctionCall] Error parseando argumentos para ${funcName}:`, e);
                }

                console.log(`[FunctionCall] Función requerida: ${funcName}`, args);
                
                let result = "";
                try {
                    // =========================================================
                    // 🚨 AQUÍ MAPEAR Y EJECUTAR TUS FUNCIONES REALES DEL BACKEND
                    // =========================================================
                    if (funcName === 'checkAvailability') {
                        // Ejemplo: result = await realApiFunctionToReserve(args.date, args.partySize);
                        result = JSON.stringify({ success: true, message: "Hay lugar para reservar." });
                    } else if (funcName === 'createReservation') {
                        result = JSON.stringify({ success: true, message: "La Reserva ha sido creada exitosamente." });
                    } else {
                        result = JSON.stringify({ error: `Function ${funcName} not implemented in bot environment` });
                    }
                } catch (e: any) {
                    result = JSON.stringify({ error: e.message || String(e) });
                }

                // Asegurar formato esperado por OpenAI para Tool Output
                return {
                    tool_call_id: toolCall.id,
                    output: result,
                };
            }));
            
            console.log(`[FunctionCall] Enviando resultados de ${toolCalls.length} funciones de vuelta a OpenAI...`);
            
            // Retornamos la respuesta interna al Run correspondiente. Esto forzará a OpenAI a continuar evaluando
            const newRun = await openai.beta.threads.runs.submitToolOutputsAndPoll(
               threadId,
               run.id,
               { tool_outputs: toolOutputs }
            );
            
            // Evaluamos otra vez recursivamente (OpenAI quizás pide otra Tool seguida, o finalmente da el 'completed' con la respuesta de texto informando al usuario)
            return handleRunStatus(newRun);
        } else if (['cancelled', 'failed', 'expired'].includes(run.status)) {
            console.error(`[askWithFunctions] Run falló o fue cancelado, estado: ${run.status}`);
            throw new Error(`Execution ended with status: ${run.status}`);
        } else {
            // Espera activa de estado
            await new Promise(r => setTimeout(r, 2000));
            const polledRun = await openai.beta.threads.runs.retrieve(threadId, run.id);
            return handleRunStatus(polledRun);
        }
    };

    const run = await openai.beta.threads.runs.createAndPoll(threadId, {
        assistant_id: assistantId
    });

    return await handleRunStatus(run);
};
```

---

## 2. Adaptar tu wrapper de seguridad (\`safeToAsk\`)

En base al nuevo controlador, ahora tu función principal de conexión (la cual posee tus lógicas de seguridad, reintentos de cancelaciones por Thread Atrapado y recargas), debe mandar sus cargas útiles hacia **`askWithFunctions`**.

Busca y reemplaza tus variables que emitan respuestas enviadas hacia `toAsk(...)` o `openai.beta.threads.messages...`, como en el siguiente ejemplo:

```typescript
export const safeToAsk = async (
  assistantId: string,
  message: string,
  state: any,
  userId: string,
  errorReporter?: any
) => {
    // ... logica previa
    try {
        // En lugar de usar toAsk de BuilderBot
        // const result = await toAsk(assistantId, message, state); 
        
        const result = await askWithFunctions(assistantId, message, state);
        return result;
    } catch (e) {
        // ... Logica de reintento previa
    }
}
```

---

## 3. Alta de Tools en la Web de OpenAI

Para que el modelo sepa que puede "detener" la conversación y llamarte, en su configurador Web (Plataforma OpenAI Assistants) en el campo superior donde configuras System Prompts y Modelos, **tienes un apartado llamado "Tools" (Functions)**. 

Desde ahí debes definir con un esquema JSON rígido los campos que tu código espera, como se visualiza en este ejemplo para una función que busca lugar libre:

```json
{
  "name": "checkAvailability",
  "description": "Verifica si existe disponibilidad para una fecha límite de tiempo y número de mesa especifico.",
  "parameters": {
    "type": "object",
    "properties": {
      "partySize": {
        "type": "integer",
        "description": "Cantidad de personas de la reserva"
      },
      "date": {
        "type": "string",
        "description": "Fecha y hora solicitada en formato YYYY-MM-DD HH:MM (ej: 2024-10-15 20:30)"
      }
    },
    "required": [
      "partySize",
      "date"
    ]
  }
}
```

---

## 4. Modificación Crítica de Prompt (Directrices System Prompt)

El "System Prompt" del Asistente debe despojarse de la forma arcaica en la que se le dictaba que debía retornar un bloque de texto mágico de su propia autoría. En su lugar, explícitamente dile qué usar usando verbos imperativos:

> ❌ **Modo Antiguo (A Eliminar):**
> *Para validar si hay lugar disponible, emite exactamente y únicamente el texto `[API: {"T": "checkAvailability", "D": "2024-10..."}]` al inicio de tu respuesta. Espera sin emitir otro texto hasta que un script humano te retorne el estado.*

> ✅ **Nuevo Estándar Tool Calling (A Aplicar):**
> *Para validar si hay lugar disponible debes utilizar obligatoriamente la herramienta "checkAvailability". Llama a la herramienta y mantente a la espera del resultado de la operación que se ejecutó a tus espaldas antes de generar tu propia frase de texto al usuario corroborando la situación.*

---

## 5. Inyección de Contexto Dinámico (EXTRA_SYSTEM_PROMPT)

Es altamente recomendado añadir una variable de entorno para inyectar reglas críticas o recordatorios fuertes (System Prompts extra) a una distancia muy corta en el contexto de la IA. Esto evita que la LLM olvide reglas importantes a lo largo de un hilo extenso o que no respete convenciones estrictas de respuesta.

En tu envoltorio (`src/app.ts`), localiza la asignación del `systemPrompt`, que probablemente se ve como esta línea que añade la hora actual, y súmale la lectura del texto de refuerzo desde `.env`:

```typescript
const getAssistantResponse = async (/* ... */) => {
  const currentDatetimeArg = getArgentinaDatetimeString();
  let systemPrompt = `Fecha, hora y día de la semana de referencia: ${currentDatetimeArg}`;
  
  // Novedad: Inyectamos el texto de refuerzo si existe en el .env
  if (process.env.EXTRA_SYSTEM_PROMPT) {
      systemPrompt += `\nInstrucción de refuerzo: ${process.env.EXTRA_SYSTEM_PROMPT}`;
  }

  // ...
```

De esta manera, puedes controlar fuertemente el comportamiento de cada instancia del bot simplemente agregando directivas en el archivo `.env`:

```env
EXTRA_SYSTEM_PROMPT="REGLA ESTRICTA: El restaurante no tiene menú vegano. No inventes platos."
```
