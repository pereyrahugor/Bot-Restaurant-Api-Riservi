// src/utils/AssistantResponseProcessor.ts
import { JsonBlockFinder } from "../Api-Riservi/JsonBlockFinder";
import { checkAvailability, createReservation, updateReservationById, cancelReservationById } from "../Api-Riservi/riservi";
import fs from 'fs';
import moment from 'moment';

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
            const tipo = jsonData.type.trim();

            if (tipo === "#DISPONIBLE#") {
                const fechaOriginal = jsonData.date;
                const fechaCorregida = corregirFechaAnioVigente(fechaOriginal);
                if (fechaOriginal !== fechaCorregida) jsonData.date = fechaCorregida;
                if (!esFechaFutura(jsonData.date)) {
                    await flowDynamic([{ body: "La fecha debe ser igual o posterior a hoy. Por favor, elegí una fecha válida." }]);
                    return;
                }
                console.log('[API Debug] Llamada a checkAvailability:', jsonData.date, jsonData.partySize);
                const apiResponse = await checkAvailability(jsonData.date, jsonData.partySize, process.env.RESERVI_API_KEY);
                console.log('[API Debug] Respuesta de checkAvailability:', apiResponse);
                const logPath = 'd:/Dev/Bot-Restaurant-Api-Riservi/logs/checkAvailability_full_response.txt';
                try {
                    fs.appendFileSync(logPath, `\n--- Nueva respuesta ---\n${JSON.stringify(apiResponse, null, 2)}\n`);
                } catch (err) {
                    console.error('[Log Error] No se pudo guardar la respuesta completa en el archivo:', err);
                }
                console.log('[API Debug] Respuesta COMPLETA de checkAvailability guardada en logs/checkAvailability_full_response.txt');
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
                    const pedirDatos = `Por favor, completa los datos restantes para la reserva del ${jsonData.date} para ${jsonData.partySize} personas (nombre, teléfono, email, etc).`;
                    const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, pedirDatos, state, undefined, ctx.from, ctx.from);
                    if (assistantApiResponse) await flowDynamic([{ body: limpiarBloquesJSON(String(assistantApiResponse)).trim() }]);
                    return;
                } else if (horariosDisponibles.length > 0) {
                    // No hay disponibilidad exacta, pero hay horarios alternativos
                    const resumen = `No hay disponibilidad para la fecha/hora solicitada. Horarios alternativos disponibles: ${horariosDisponibles.join(", ")}`;
                    const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, resumen, state, "Por favor, responde aunque sea brevemente.", ctx.from, ctx.from);
                    if (assistantApiResponse) await flowDynamic([{ body: limpiarBloquesJSON(String(assistantApiResponse)).trim() }]);
                    return;
                } else {
                    // No hay disponibilidad en ningún horario
                    const resumen = "No hay horarios disponibles para la fecha y cantidad de personas solicitadas.";
                    const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, resumen, state, "Por favor, responde aunque sea brevemente.", ctx.from, ctx.from);
                    if (assistantApiResponse) await flowDynamic([{ body: limpiarBloquesJSON(String(assistantApiResponse)).trim() }]);
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
                    await flowDynamic([{ body: "Ya estamos procesando una reserva. Espera la confirmación antes de solicitar otra." }]);
                    return;
                }
                state.reservaEnCurso = true;
                const fechaOriginal = jsonData.date;
                const fechaCorregida = corregirFechaAnioVigente(fechaOriginal);
                if (fechaOriginal !== fechaCorregida) jsonData.date = fechaCorregida;
                if (!esFechaFutura(jsonData.date)) {
                    state.reservaEnCurso = false;
                    await flowDynamic([{ body: "La fecha debe ser igual o posterior a hoy. Por favor, elegí una fecha válida." }]);
                    return;
                }
                // Siempre llamar a la API antes de limpiar/enviar el texto
                console.log('[Debug] RESERVA: Payload para createReservation:', JSON.stringify(jsonData));
                console.log('[API Debug] Llamada a createReservation:', JSON.stringify(jsonData));
                let apiResponse;
                let reservaId = null;
                let apiError = null;
                try {
                    apiResponse = await createReservation(jsonData, process.env.RESERVI_API_KEY);
                    console.log('[API Debug] Respuesta de createReservation:', apiResponse);
                    reservaId = apiResponse && (apiResponse.reservaId || apiResponse.id || apiResponse.bookingId || apiResponse.reservationId);
                    if (apiResponse && (apiResponse.error || apiResponse.errors)) {
                        apiError = apiResponse.error || JSON.stringify(apiResponse.errors);
                    }
                } catch (err) {
                    apiError = err?.message || String(err);
                    console.error('[Debug] RESERVA: Error en createReservation:', err);
                }
                // Si hay error, enviar al usuario y no reintentar
                if (apiError) {
                    await flowDynamic([{ body: `No se pudo crear la reserva: ${apiError}` }]);
                    state.reservaEnCurso = false;
                    return;
                }
                // Enviar confirmación simple al usuario con el ID real
                if (reservaId) {
                    await flowDynamic([{ body: `reserva confirmada ID:${reservaId}` }]);
                } else {
                    await flowDynamic([{ body: `No se recibió confirmación de la reserva. Por favor, intenta nuevamente o consulta con el restaurante.` }]);
                }
                state.reservaEnCurso = false;
                return;
            }

            if (tipo === "#MODIFICAR#") {
                console.log('[API Debug] Llamada a updateReservationById:', jsonData.id, jsonData.date, jsonData.partySize);
                const apiResponse = await updateReservationById(jsonData.id, jsonData.date, jsonData.partySize, process.env.RESERVI_API_KEY);
                console.log('[API Debug] Respuesta de updateReservationById:', apiResponse);
                const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, typeof apiResponse === "string" ? apiResponse : JSON.stringify(apiResponse), state, undefined, ctx.from, ctx.from);
                if (assistantApiResponse) await flowDynamic([{ body: limpiarBloquesJSON(String(assistantApiResponse)).trim() }]);
                return;
            }

            if (tipo === "#CANCELAR#") {
                console.log('[API Debug] Llamada a cancelReservationById:', jsonData.id);
                const apiResponse = await cancelReservationById(jsonData.id, process.env.RESERVI_API_KEY);
                console.log('[API Debug] Respuesta de cancelReservationById:', apiResponse);
                const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, typeof apiResponse === "string" ? apiResponse : JSON.stringify(apiResponse), state, undefined, ctx.from, ctx.from);
                if (assistantApiResponse) await flowDynamic([{ body: limpiarBloquesJSON(String(assistantApiResponse)).trim() }]);
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
                await flowDynamic([{ body: limpiarBloquesJSON(String(assistantApiResponse)).trim() }]);
            }
        } else if (cleanTextResponse.length > 0) {
            const chunks = cleanTextResponse.split(/\n\n+/);
            for (const chunk of chunks) {
                if (chunk.trim().length > 0) {
                    await flowDynamic([{ body: chunk.trim() }]);
                }
            }
        }
    }
}

