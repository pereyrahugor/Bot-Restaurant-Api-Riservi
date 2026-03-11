// src/utils/AssistantResponseProcessor.ts
// Ajustar fecha/hora a GMT-3 (hora argentina)
function toArgentinaTime(fechaReservaStr: string): string {
    const [fecha, hora] = fechaReservaStr.split(' ');
    const [anio, mes, dia] = fecha.split('-').map(Number);
    const [hh, min] = hora.split(':').map(Number);
    const date = new Date(Date.UTC(anio, mes - 1, dia, hh, min));
    date.setHours(date.getHours() - 3);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hhh = String(date.getHours()).padStart(2, '0');
    const mmm = String(date.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hhh}:${mmm}`;
}
import { JsonBlockFinder } from "../Api-Riservi/JsonBlockFinder";
import { checkAvailability, createReservation, updateReservationById, cancelReservationById, confirmReservationById } from "../Api-Riservi/riservi";
import { ApiQueue } from "./ApiQueue";
import fs from 'fs';
import moment from 'moment';
import { HistoryHandler } from './historyHandler';
import OpenAI from "openai";
import { toAsk } from "@builderbot-plugins/openai-assistants";

export const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

export async function waitForActiveRuns(threadId: string) {
    if (!threadId) return;
    try {
        let attempt = 0;
        const maxAttempts = 10; 
        let requiresActionCount = 0;

        while (attempt < maxAttempts) {
            const runs = await openai.beta.threads.runs.list(threadId, { limit: 10 });
            const activeRun = runs.data.find(run => 
                ["queued", "in_progress", "cancelling", "requires_action"].includes(run.status)
            );
            
            if (activeRun) {
                console.log(`[AssistantResponseProcessor] [${attempt}/${maxAttempts}] Run activo detectado (${activeRun.id}, estado: ${activeRun.status}).`);
                
                // Si el run está en 'requires_action' o 'in_progress' por más de 3 chequeos (aprox 6 segundos), 
                // intentamos cancelarlo para liberar el hilo.
                if (activeRun.status === "requires_action" || (activeRun.status === "in_progress" && attempt >= 5)) {
                    requiresActionCount++;
                    if (requiresActionCount >= 2 || attempt >= 7) {
                        console.warn(`[AssistantResponseProcessor] Run ${activeRun.id} parece estancado (${activeRun.status}). Cancelando...`);
                        try {
                            await openai.beta.threads.runs.cancel(threadId, activeRun.id);
                        } catch (cancelErr: any) {
                            const msg = cancelErr?.message || String(cancelErr);
                            if (msg.includes('404') || msg.includes('not found')) {
                                console.log(`[AssistantResponseProcessor] Run ya no existe, hilo liberado.`);
                                return;
                            }
                            console.error(`[AssistantResponseProcessor] Error al cancelar run:`, cancelErr);
                        }
                    }
                }

                await new Promise(resolve => setTimeout(resolve, 2000));
                attempt++;
            } else {
                return;
            }
        }
    } catch (error) {
        // console.error(`[AssistantResponseProcessor] Error verificando runs:`, error);
    }
}

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
    const threadId = state && typeof state.get === 'function' && state.get('thread_id');
    if (threadId) {
      try {
        await waitForActiveRuns(threadId);
      } catch (err) {
        // console.error('[safeToAsk] Error esperando runs activos:', err);
      }
    }
    try {
      return await toAsk(assistantId, message, state);
    } catch (err: any) {
      attempt++;
      const errorMessage = err?.message || String(err);
      // console.error(`[safeToAsk] Error OpenAI (Intento ${attempt}/${maxRetries}):`, errorMessage);

      // Estrategia de Cancelación Proactiva Mejorada
      if (errorMessage.includes('while a run') && errorMessage.includes('is active') && threadId) {
        const runIdMatch = errorMessage.match(/run_[a-zA-Z0-9]+/);
        if (runIdMatch) {
          const activeRunId = runIdMatch[0];
          console.log(`[safeToAsk] Cancelando run ${activeRunId} que bloquea el hilo...`);
          try {
            await openai.beta.threads.runs.cancel(threadId, activeRunId);
            console.log(`[safeToAsk] Cancelación enviada para ${activeRunId}. Reintentando inmediatamente...`);
            await new Promise(r => setTimeout(r, 2000));
            continue; 
          } catch (cancelErr: any) {
            const cMsg = cancelErr?.message || String(cancelErr);
            if (cMsg.includes('404') || cMsg.includes('not found')) {
                // console.log(`[safeToAsk] El run ${activeRunId} ya terminó o fue cancelado. Reintentando...`);
                await new Promise(r => setTimeout(r, 1000));
                continue; 
            }
            // console.error(`[safeToAsk] Error cancelando run:`, cancelErr);
          }
        }
      }

      if (attempt >= maxRetries) {
        // console.error(`[safeToAsk] Fallo tras ${maxRetries} intentos. Renovando hilo...`);
        try {
            if (errorReporter) {
                await errorReporter.reportError(
                    new Error(`Hilo ${threadId} bloqueado. Renovando automáticamente.`),
                    userId,
                    `https://wa.me/${userId}`
                );
            }

            const history = await HistoryHandler.getMessages(userId, 5);
            const threadMessages = history
                .filter(m => m.role === 'user' || m.role === 'assistant')
                .map(m => ({
                    role: m.role as 'user' | 'assistant',
                    content: m.content
                }));

            const newThread = await openai.beta.threads.create({
                messages: threadMessages as any
            });
            
            console.log(`[safeToAsk] Hilo renovado por errores persistentes: ${newThread.id}.`);
            await state.update({ thread_id: newThread.id });
            
            // Un último intento con el nuevo hilo
            return await toAsk(assistantId, message, state);
        } catch (renewalErr: any) {
            console.error(`[safeToAsk] Error fatal al renovar hilo:`, renewalErr);
            throw err; 
        }
      }
      
      const waitTime = Math.min(attempt * 2000, 10000);
      await new Promise(r => setTimeout(r, waitTime));
    }
  }
};


// Mapa global para bloquear usuarios de WhatsApp durante operaciones API
const userApiBlockMap = new Map();
const API_BLOCK_TIMEOUT_MS = 60000; // 60 segundos de bloqueo durante operación API

// --- NUEVA LÓGICA DE COLAS POR ENDPOINT ---
// Definir colas para cada endpoint
const createReservationQueue = new ApiQueue(
    (args: { data: any; apiKey: string }) =>
        createReservation(args.data, args.apiKey)
);

function limpiarBloquesJSON(texto: string): string {
    // 1. Eliminar completamente los bloques de metadatos y API para que no se envíen al usuario
    // y evitar ecos que activen el bloqueo de seguridad.
    let limpio = texto;
    
    // Eliminar [API]...[/API] (Lógica de asistente)
    limpio = limpio.replace(/\[\s*API\s*\][\s\S]*?\[\/\s*API\s*\]/gi, "");
    
    // Eliminar [DB_QUERY: ...] y [DB: ...]
    limpio = limpio.replace(/\[\s*DB_QUERY\s*:?\s*[\s\S]*?\]/gi, "");
    limpio = limpio.replace(/\[\s*DB\s*:?\s*[\s\S]*?\]/gi, "");
    
    // Eliminar bloques de PDF [PDF: ID]
    limpio = limpio.replace(/\[\s*PDF\s*:\s*[\s\S]*?\]/gi, "");

    // Eliminar SYSTEM_DB_RESULT o SYSTEM_API_RESULT
    limpio = limpio.replace(/\[?\s*SYSTEM_(DB|API)_RESULT[\s\S]*?(?:\]|$)/gi, "");

    // 2. Limpiar referencias de OpenAI tipo 【4:0†archivo.pdf】
    limpio = limpio.replace(/【.*?】/g, "");

    // 3. Limpiar bloques JSON de "queries" que a veces fuga el asistente
    limpio = limpio.replace(/\{\s*"queries"\s*:\s*\[[\s\S]*?\]\s*\}[\s,]*?/gi, "");
    
    return limpio.trim();
}

function corregirFechaAnioVigente(fechaReservaStr: string): string {
    const ahora = new Date();
    const vigente = ahora.getFullYear();
    const [fecha, hora] = fechaReservaStr.split(" ");
    const [anioRaw, mes, dia] = fecha.split("-").map(Number);
    let anio = anioRaw;
    if (anio < vigente) anio = vigente;
    return `${anio.toString().padStart(4, "0")}-${mes.toString().padStart(2, "0")}-${dia.toString().padStart(2, "0")} ${hora}`;
}

function esFechaFutura(fechaReservaStr: string): boolean {
    const ahora = new Date();
    const fechaReserva = new Date(fechaReservaStr.replace(" ", "T"));
    return fechaReserva >= ahora;
}

export class AssistantResponseProcessor {
    static async analizarYProcesarRespuestaAsistente(
        response: any,
        ctx: any,
                                                                                                                                                                                         flowDynamic: any,
        state: any,
        provider: any,
        gotoFlow: any,
        getAssistantResponse: Function,
        ASSISTANT_ID: string,
        isRecursive: boolean = false
    ) {
        // Log de mensaje entrante del asistente (antes de cualquier filtro)
        if (ctx && ctx.type === 'webchat') {
            console.log('[Webchat Debug] Mensaje entrante del asistente:', response);
        } else {
            console.log('[WhatsApp Debug] Analizando respuesta de asistente para:', ctx.from);
            // Si el usuario está bloqueado por una operación API, evitar procesar nuevos mensajes de entrada
            // (como mensajes rápidos del usuario o ecos accidentales), pero permitir las llamadas recursivas internas del bot.
            if (!isRecursive && ctx.from && userApiBlockMap.has(ctx.from)) {
                console.log(`[API Block] Ignorando entrada (usuario bloqueado en medio de operación API): ${ctx.from}`);
                return;
            }
        }
        let jsonData: any = null;
        const textResponse = typeof response === "string" ? response : String(response || "");

        // Log de mensaje para seguimiento (opcional, se puede silenciar)
        if (ctx && ctx.type === 'webchat') {
            console.log('[Webchat Debug] Contenido respuesta:', textResponse);
        }
        // 1) Extraer bloque [API] ... [/API]
        const apiBlockRegex = /\[API\](.*?)\[\/API\]/is;
        const match = textResponse.match(apiBlockRegex);
        if (match) {
            const jsonStr = match[1].trim();
            console.log('[Debug] Bloque [API] detectado:', jsonStr);
            try {
                jsonData = JSON.parse(jsonStr);
            } catch (e) {
                jsonData = null;
                if (ctx && ctx.type === 'webchat') {
                    console.log('[Webchat Debug] Error al parsear bloque [API]:', jsonStr);
                }
            }
        }

        // 2) Fallback heurístico (desactivado, solo [API])
        // jsonData = null;
        if (!jsonData) {
            jsonData = JsonBlockFinder.buscarBloquesJSONEnTexto(textResponse) || (typeof response === "object" ? JsonBlockFinder.buscarBloquesJSONProfundo(response) : null);
            if (!jsonData && ctx && ctx.type === 'webchat') {
                console.log('[Webchat Debug] No JSON block detected in assistant response. Raw output:', textResponse);
            }
        }

        // 3) Procesar JSON si existe
        if (jsonData && typeof jsonData.type === "string") {
            // Si es WhatsApp, bloquear usuario por 20 segundos o hasta finalizar la operación API
            let unblockUser = null;
            if (ctx && ctx.type !== 'webchat' && ctx.from) {
                userApiBlockMap.set(ctx.from, true);
                // Desbloqueo automático tras timeout de seguridad
                const timeoutId = setTimeout(() => {
                    userApiBlockMap.delete(ctx.from);
                }, API_BLOCK_TIMEOUT_MS);
                unblockUser = () => {
                    clearTimeout(timeoutId);
                    userApiBlockMap.delete(ctx.from);
                };
            }
            // Log para detectar canal y datos antes de enviar
            if (ctx && ctx.type !== 'webchat') {
                console.log('[WhatsApp Debug] Antes de enviar con flowDynamic o procesar API:', jsonData, ctx.from);
            }
            const tipo = jsonData.type.trim();

            // --- VALIDACIÓN DE LÍMITE DE COMENSALES ---
            const currentPartySize = jsonData.partySize;
            if (['#DISPONIBLE#', '#RESERVA#', '#MODIFICAR#'].includes(tipo) && typeof currentPartySize === 'number' && currentPartySize >= 13) {
                const limitMsg = `Limite de comensales exedido, la cantidad solicitada es para ${currentPartySize} de comensales, derivar a linea Eventos`;
                // console.log(`[Validation] Límite de comensales excedido: ${currentPartySize}`);
                
                const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, limitMsg, state, undefined, ctx.from, ctx.from);
                    await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                        assistantApiResponse,
                        ctx,
                        flowDynamic,
                        state,
                        provider,
                        gotoFlow,
                        getAssistantResponse,
                        ASSISTANT_ID,
                        true
                    );
                if (unblockUser) unblockUser();
                return;
            }

            if (tipo === "#DISPONIBLE#") {
                const fechaOriginal = jsonData.date;
                // Solo usar la fecha/hora corregida para contexto del asistente, no para la reserva
                const fechaCorregida = corregirFechaAnioVigente(fechaOriginal);
                const fechaArgentina = toArgentinaTime(fechaCorregida);
                // NO modificar jsonData.date, mantener la hora original del usuario
                // Control de fecha futura eliminado (ya validado antes)
                // console.log('[API Debug] Llamada a checkAvailability:', jsonData.date, jsonData.partySize);
                let apiResponse;
                try {
                    // Llamada directa a checkAvailability
                    apiResponse = await checkAvailability(
                        jsonData.date,
                        jsonData.partySize,
                        process.env.RESERVI_API_KEY
                    );
                    // console.log('[API Debug] Respuesta de checkAvailability:', apiResponse);
                } catch (error) {
                    // console.error('[API Error] Error en checkAvailability:', error);
                    // Notificar al asistente para que pueda decidir reintentar
                    const errorMsg = `Error al consultar disponibilidad: ${error.message || String(error)}. ¿Deseas volver a intentar la consulta?`;
                    const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, errorMsg, state, undefined, ctx.from, ctx.from);
                    if (assistantApiResponse) {
                        await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                            assistantApiResponse,
                            ctx,
                            flowDynamic,
                            state,
                            provider,
                            gotoFlow,
                            getAssistantResponse,
                            ASSISTANT_ID,
                        true
                        );
                    }
                    if (unblockUser) unblockUser();
                    return;
                }
                const tempDir = 'temp';
                const tempPath = tempDir + '/checkAvailability_full_response.txt';
                try {
                    if (!fs.existsSync(tempDir)) {
                        fs.mkdirSync(tempDir, { recursive: true });
                    }
                    fs.writeFileSync(tempPath, JSON.stringify(apiResponse, null, 2));
                } catch (err) {
                    // console.error('[Log Error] No se pudo guardar la respuesta completa en el archivo:', err);
                }
                // ...verificación o uso del archivo...
                // Eliminar el archivo después de la verificación
                try {
                    fs.unlinkSync(tempPath);
                } catch (err) {
                    // Si falla el borrado, solo loguear
                    // console.warn('[Log Warn] No se pudo eliminar el archivo temporal:', err);
                }
                let disponibilidadExacta = false;
                const horariosDisponibles: string[] = [];
                if (apiResponse?.response?.response?.availability) {
                    // console.log('[Disponibilidad] response.response.availability:', JSON.stringify(apiResponse.response.response.availability, null, 2));
                    const queryTime = moment(jsonData.date, ["YYYY-MM-DD HH:mm", "YYYY-MM-DDTHH:mm", moment.ISO_8601]).format("YYYY-MM-DD HH:mm");
                    for (const slot of apiResponse.response.response.availability) {
                        const slotTime = moment(slot.time, ["YYYY-MM-DD HH:mm", "YYYY-MM-DDTHH:mm", moment.ISO_8601]).format("YYYY-MM-DD HH:mm");
                        // console.log(`[Disponibilidad] Slot: time=${slotTime}, available=${slot.available}`);
                        // Verifica fecha y disponibilidad usando el dato enviado a la API
                        if (slotTime === queryTime && slot.available) {
                            disponibilidadExacta = true;
                            // console.log(`[Disponibilidad] Hora exacta encontrada: ${slotTime} disponible para reservar para partySize=${jsonData.partySize}.`);
                        } else if (slotTime === queryTime && !slot.available) {
                            // console.log(`[Disponibilidad] Hora exacta encontrada: ${slotTime} NO disponible para reservar.`);
                        }
                        if (slot.available) {
                            horariosDisponibles.push(slotTime);
                        }
                    }
                }
                // Nunca enviar la respuesta cruda de la API al usuario
                if (disponibilidadExacta) {
                    // Hay disponibilidad exacta para la fecha/hora solicitada
                    const pedirDatos = `Disponibilidad confirmada para ${jsonData.date} y ${jsonData.partySize} personas. Por favor, procede con la reserva o confirma los datos restantes con el usuario.`;
                    const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, pedirDatos, state, undefined, ctx.from, ctx.from);
                    if (assistantApiResponse) {
                        await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                            assistantApiResponse,
                            ctx,
                            flowDynamic,
                            state,
                            provider,
                            gotoFlow,
                            getAssistantResponse,
                            ASSISTANT_ID,
                            true
                        );
                    }
                    return;
                } else if (horariosDisponibles.length > 0) {
                    // No hay disponibilidad exacta, pero hay horarios alternativos
                    const resumen = `No hay disponibilidad exacta para ${jsonData.date}. Horarios alternativos disponibles: ${horariosDisponibles.join(", ")}`;
                    const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, resumen, state, "Por favor, informa al usuario sobre las alternativas.", ctx.from, ctx.from);
                    if (assistantApiResponse) {
                        await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                            assistantApiResponse,
                            ctx,
                            flowDynamic,
                            state,
                            provider,
                            gotoFlow,
                            getAssistantResponse,
                            ASSISTANT_ID,
                            true
                        );
                    }
                    return;
                } else {
                    // No hay disponibilidad en ningún horario o hubo un error silencioso
                    let resumen;
                    if (apiResponse && (apiResponse.error || apiResponse.errors)) {
                        resumen = `Error de la API: ${apiResponse.error || JSON.stringify(apiResponse.errors)}`;
                    } else {
                        resumen = "No hay horarios disponibles para la fecha y cantidad de personas solicitadas.";
                    }
                    const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, resumen, state, "Por favor, informa al usuario que no hay disponibilidad.", ctx.from, ctx.from);
                    if (assistantApiResponse) {
                        await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                            assistantApiResponse,
                            ctx,
                            flowDynamic,
                            state,
                            provider,
                            gotoFlow,
                            getAssistantResponse,
                            ASSISTANT_ID,
                            true
                        );
                    }
                    return;
                }
            }

            if (tipo === "#RESERVA#") {
                // Log con timestamp y estado
                const now = new Date().toISOString();
                // console.log(`[Debug] RESERVA: ${now} - Estado actual:`, JSON.stringify(state));
                // Evitar solapamiento: si hay una reserva en curso, no procesar otra
                if (state.reservaEnCurso) {
                    console.log(`[Debug] RESERVA: ${now} - Reserva en curso, se ignora el nuevo bloque.`);
                    try {
                        await flowDynamic([{ body: "Ya estamos procesando una reserva. Espera la confirmación antes de solicitar otra." }]);
                        if (ctx && ctx.type !== 'webchat') {
                            console.log('[WhatsApp Debug] flowDynamic ejecutado correctamente (aviso de reserva en curso)');
                        }
                    } catch (err) {
                        // console.error('[WhatsApp Debug] Error en flowDynamic:', err);
                    }
                    return;
                }
                state.reservaEnCurso = true;
                const fechaOriginal = jsonData.date;
                // Solo usar la fecha/hora corregida para contexto, no para la reserva
                // jsonData.date debe mantener la hora original recibida del asistente
                // Control de fecha futura eliminado (ya validado antes)
                // Siempre llamar a la API antes de limpiar/enviar el texto
                console.log('[Debug] RESERVA: Payload para createReservation:', JSON.stringify(jsonData));
                console.log('[API Debug] Llamada a createReservation:', JSON.stringify(jsonData));
                let apiResponse;
                let reservaId = null;
                let apiError = null;
                try {
                    // Usar la cola para createReservation
                    const result = await createReservationQueue.enqueue({
                        data: jsonData,
                        apiKey: process.env.RESERVI_API_KEY
                    }, ctx.from || "");
                    apiResponse = result.response;
                    console.log('[API Debug] Respuesta de createReservation:', apiResponse);
                    reservaId = apiResponse && (apiResponse.reservaId || apiResponse.id || apiResponse.bookingId || apiResponse.reservationId);
                    if (apiResponse && (apiResponse.error || apiResponse.errors)) {
                        apiError = apiResponse.error || JSON.stringify(apiResponse.errors);
                    }
                } catch (err) {
                    apiError = err?.message || String(err);
                    // console.error('[Debug] RESERVA: Error en createReservation:', err);
                    // Notificar al asistente para que pueda decidir reintentar
                    const errorMsg = `Error al crear la reserva: ${apiError}. ¿Deseas volver a intentar la solicitud?`;
                    const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, errorMsg, state, undefined, ctx.from, ctx.from);
                    if (assistantApiResponse) {
                        await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                            assistantApiResponse,
                            ctx,
                            flowDynamic,
                            state,
                            provider,
                            gotoFlow,
                            getAssistantResponse,
                            ASSISTANT_ID,
                            true
                        );
                    }
                    state.reservaEnCurso = false;
                    if (unblockUser) unblockUser();
                    return;
                }
                // Si hay error de lógica de negocio o de la API
                if (apiError) {
                    const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, `La API devolvió un error al intentar crear la reserva: ${apiError}`, state, undefined, ctx.from, ctx.from);
                    if (assistantApiResponse) {
                        await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                            assistantApiResponse,
                            ctx,
                            flowDynamic,
                            state,
                            provider,
                            gotoFlow,
                            getAssistantResponse,
                            ASSISTANT_ID,
                            true
                        );
                    }
                    state.reservaEnCurso = false;
                    if (unblockUser) unblockUser();
                    return;
                }
                // Enviar la respuesta de la API al asistente
                const resumenReserva = reservaId
                    ? `reserva confirmada con ID ${reservaId}`
                    : `No se recibió confirmación de la reserva. Respuesta API: ${JSON.stringify(apiResponse)}`;
                
                console.log(`[RESERVA] Enviando resultado a OpenAI para confirmación final: ${resumenReserva}`);
                const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, resumenReserva, state, undefined, ctx.from, ctx.from);
                if (assistantApiResponse) {
                    await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                        assistantApiResponse,
                        ctx,
                        flowDynamic,
                        state,
                        provider,
                        gotoFlow,
                        getAssistantResponse,
                        ASSISTANT_ID,
                        true
                    );
                } else {
                    // FALLBACK: Si OpenAI falla en el paso final, al menos enviamos un mensaje directo al usuario
                    console.warn('[RESERVA] OpenAI no respondió a la confirmación final. Enviando fallback...');
                    const fallbackMsg = reservaId 
                        ? `¡Tu reserva ha sido confirmada con el código ${reservaId}! 🎉`
                        : `Hubo un inconveniente al finalizar tu reserva. Por favor, consulta por el ID de tu reserva en unos minutos.`;
                    await flowDynamic([{ body: fallbackMsg }]);
                }
                state.reservaEnCurso = false;
                if (unblockUser) unblockUser();
                return;
            }

            if (tipo === "#MODIFICAR#") {
                let apiResponse;
                try {
                    apiResponse = await updateReservationById(
                        jsonData.id,
                        jsonData.date,
                        jsonData.partySize,
                        process.env.RESERVI_API_KEY
                    );
                } catch (error) {
                    apiResponse = { error: error.message || String(error) };
                } finally {
                    if (unblockUser) unblockUser();
                }
                // console.log('[API Debug] Respuesta de updateReservationById:', apiResponse);
                const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, typeof apiResponse === "string" ? apiResponse : JSON.stringify(apiResponse), state, undefined, ctx.from, ctx.from);
                if (assistantApiResponse) {
                    await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                        assistantApiResponse,
                        ctx,
                        flowDynamic,
                        state,
                        provider,
                        gotoFlow,
                        getAssistantResponse,
                        ASSISTANT_ID,
                        true
                    );
                }
                return;
            }

            if (tipo === "#CANCELAR#") {
                let apiResponse;
                try {
                    apiResponse = await cancelReservationById(
                        jsonData.id,
                        process.env.RESERVI_API_KEY
                    );
                } catch (error) {
                    apiResponse = { error: error.message || String(error) };
                } finally {
                    if (unblockUser) unblockUser();
                }
                // console.log('[API Debug] Respuesta de cancelReservationById:', apiResponse);
                const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, typeof apiResponse === "string" ? apiResponse : JSON.stringify(apiResponse), state, undefined, ctx.from, ctx.from);
                if (assistantApiResponse) {
                    await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                        assistantApiResponse,
                        ctx,
                        flowDynamic,
                        state,
                        provider,
                        gotoFlow,
                        getAssistantResponse,
                        ASSISTANT_ID,
                        true
                    );
                }
                return;
            }

            if (tipo === "#CONFIRMAR#") {
                let apiResponse;
                try {
                    apiResponse = await confirmReservationById(
                        jsonData.id,
                        process.env.RESERVI_API_KEY
                    );
                } catch (error) {
                    apiResponse = { error: error.message || String(error) };
                } finally {
                    if (unblockUser) unblockUser();
                }
                // console.log('[API Debug] Respuesta de confirmReservationById:', apiResponse);
                const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, typeof apiResponse === "string" ? apiResponse : JSON.stringify(apiResponse), state, undefined, ctx.from, ctx.from);
                if (assistantApiResponse) {
                    await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                        assistantApiResponse,
                        ctx,
                        flowDynamic,
                        state,
                        provider,
                        gotoFlow,
                        getAssistantResponse,
                        ASSISTANT_ID,
                        true
                    );
                }
                return;
            }
        }

        // Si no hubo bloque JSON válido, enviar el texto limpio
    const cleanTextResponse = limpiarBloquesJSON(textResponse).trim();
        // Lógica especial para reserva: espera y reintento
        if (cleanTextResponse.includes('Voy a proceder a realizar la reserva.')) {
            // Espera 30 segundos y responde ok al asistente
            await new Promise(res => setTimeout(res, 30000));
            let assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, 'ok', state, undefined, ctx.from, ctx.from);
            // Si la respuesta contiene (ID: ...), no la envíes al usuario, espera 10s y vuelve a enviar ok
            while (assistantApiResponse && /(ID:\s*\w+)/.test(assistantApiResponse)) {
                // console.log('[Debug] Respuesta contiene ID de reserva, esperando 10s y reenviando ok...');
                await new Promise(res => setTimeout(res, 10000));
                assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, 'ok', state, undefined, ctx.from, ctx.from);
            }
            // Cuando la respuesta no contiene el ID, envíala al usuario
            if (assistantApiResponse) {
                try {
                    await flowDynamic([{ body: limpiarBloquesJSON(String(assistantApiResponse)).trim() }]);
                    if (ctx && ctx.type !== 'webchat') {
                        console.log('[WhatsApp Debug] flowDynamic ejecutado correctamente');
                    }
                } catch (err) {
                    console.error('[WhatsApp Debug] Error en flowDynamic:', err);
                }
            }
        } else if (cleanTextResponse.length > 0) {
            // Guardar en Supabase antes de fragmentar
            if (ctx && ctx.from) {
                await HistoryHandler.saveMessage(ctx.from, 'assistant', cleanTextResponse, 'text');
            }

            const chunks = cleanTextResponse.split(/\n\n+/);
            for (const chunk of chunks) {
                if (chunk.trim().length > 0) {
                    try {
                        await flowDynamic([{ body: chunk.trim() }]);
                        if (ctx && ctx.type !== 'webchat') {
                            console.log('[WhatsApp Debug] flowDynamic ejecutado correctamente');
                        }
                    } catch (err) {
                        console.error('[WhatsApp Debug] Error en flowDynamic:', err);
                    }
                }
            }
        }
    }
}

