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


// Mapa global para bloquear usuarios de WhatsApp durante operaciones API
const userApiBlockMap = new Map();
const API_BLOCK_TIMEOUT_MS = 1000; // 5 segundos

// --- NUEVA LÓGICA DE COLAS POR ENDPOINT ---
// Definir colas para cada endpoint
const createReservationQueue = new ApiQueue(
    (args: { data: any; apiKey: string }) =>
        createReservation(args.data, args.apiKey)
);

function limpiarBloquesJSON(texto: string): string {
    return texto.replace(/\[API\][\s\S]*?\[\/API\]/g, "");
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
        ASSISTANT_ID: string
    ) {
        // Log de mensaje entrante del asistente (antes de cualquier filtro)
        if (ctx && ctx.type === 'webchat') {
            console.log('[Webchat Debug] Mensaje entrante del asistente:', response);
        } else {
            console.log('[WhatsApp Debug] Mensaje entrante del asistente:', response);
            // Si el usuario está bloqueado por una operación API, evitar procesar nuevos mensajes
            if (userApiBlockMap.has(ctx.from)) {
                console.log(`[API Block] Mensaje ignorado de usuario bloqueado: ${ctx.from}`);
                return;
            }
        }
        let jsonData: any = null;
        const textResponse = typeof response === "string" ? response : String(response || "");

        // Log de mensaje saliente al usuario (antes de cualquier filtro)
        if (ctx && ctx.type === 'webchat') {
            console.log('[Webchat Debug] Mensaje saliente al usuario (sin filtrar):', textResponse);
        } else {
            console.log('[WhatsApp Debug] Mensaje saliente al usuario (sin filtrar):', textResponse);
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
                console.log('[WhatsApp Debug] Antes de enviar con flowDynamic:', jsonData, ctx.from);
            }
            const tipo = jsonData.type.trim();

            if (tipo === "#DISPONIBLE#") {
                const fechaOriginal = jsonData.date;
                // Solo usar la fecha/hora corregida para contexto del asistente, no para la reserva
                const fechaCorregida = corregirFechaAnioVigente(fechaOriginal);
                const fechaArgentina = toArgentinaTime(fechaCorregida);
                // NO modificar jsonData.date, mantener la hora original del usuario
                // Control de fecha futura eliminado (ya validado antes)
                console.log('[API Debug] Llamada a checkAvailability:', jsonData.date, jsonData.partySize);
                let apiResponse;
                try {
                    // Llamada directa a checkAvailability
                    apiResponse = await checkAvailability(
                        jsonData.date,
                        jsonData.partySize,
                        process.env.RESERVI_API_KEY
                    );
                    console.log('[API Debug] Respuesta de checkAvailability:', apiResponse);
                } catch (error) {
                    console.error('[API Error] Error en checkAvailability:', error);
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
                            ASSISTANT_ID
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
                    console.error('[Log Error] No se pudo guardar la respuesta completa en el archivo:', err);
                }
                // ...verificación o uso del archivo...
                // Eliminar el archivo después de la verificación
                try {
                    fs.unlinkSync(tempPath);
                } catch (err) {
                    // Si falla el borrado, solo loguear
                    console.warn('[Log Warn] No se pudo eliminar el archivo temporal:', err);
                }
                let disponibilidadExacta = false;
                const horariosDisponibles: string[] = [];
                if (apiResponse?.response?.response?.availability) {
                    console.log('[Disponibilidad] response.response.availability:', JSON.stringify(apiResponse.response.response.availability, null, 2));
                    const queryTime = moment(jsonData.date, ["YYYY-MM-DD HH:mm", "YYYY-MM-DDTHH:mm", moment.ISO_8601]).format("YYYY-MM-DD HH:mm");
                    for (const slot of apiResponse.response.response.availability) {
                        const slotTime = moment(slot.time, ["YYYY-MM-DD HH:mm", "YYYY-MM-DDTHH:mm", moment.ISO_8601]).format("YYYY-MM-DD HH:mm");
                        console.log(`[Disponibilidad] Slot: time=${slotTime}, available=${slot.available}`);
                        // Verifica fecha y disponibilidad usando el dato enviado a la API
                        if (slotTime === queryTime && slot.available) {
                            disponibilidadExacta = true;
                            console.log(`[Disponibilidad] Hora exacta encontrada: ${slotTime} disponible para reservar para partySize=${jsonData.partySize}.`);
                        } else if (slotTime === queryTime && !slot.available) {
                            console.log(`[Disponibilidad] Hora exacta encontrada: ${slotTime} NO disponible para reservar.`);
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
                            ASSISTANT_ID
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
                            ASSISTANT_ID
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
                            ASSISTANT_ID
                        );
                    }
                    return;
                }
            }

            if (tipo === "#RESERVA#") {
                // Log con timestamp y estado
                const now = new Date().toISOString();
                console.log(`[Debug] RESERVA: ${now} - Estado actual:`, JSON.stringify(state));
                // Evitar solapamiento: si hay una reserva en curso, no procesar otra
                if (state.reservaEnCurso) {
                    console.log(`[Debug] RESERVA: ${now} - Reserva en curso, se ignora el nuevo bloque.`);
                    try {
                        await flowDynamic([{ body: "Ya estamos procesando una reserva. Espera la confirmación antes de solicitar otra." }]);
                        if (ctx && ctx.type !== 'webchat') {
                            console.log('[WhatsApp Debug] flowDynamic ejecutado correctamente');
                        }
                    } catch (err) {
                        console.error('[WhatsApp Debug] Error en flowDynamic:', err);
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
                    console.error('[Debug] RESERVA: Error en createReservation:', err);
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
                            ASSISTANT_ID
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
                            ASSISTANT_ID
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
                        ASSISTANT_ID
                    );
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
                console.log('[API Debug] Respuesta de updateReservationById:', apiResponse);
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
                        ASSISTANT_ID
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
                console.log('[API Debug] Respuesta de cancelReservationById:', apiResponse);
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
                        ASSISTANT_ID
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
                console.log('[API Debug] Respuesta de confirmReservationById:', apiResponse);
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
                        ASSISTANT_ID
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
                console.log('[Debug] Respuesta contiene ID de reserva, esperando 10s y reenviando ok...');
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

