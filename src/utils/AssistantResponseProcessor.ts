// src/utils/AssistantResponseProcessor.ts
import { JsonBlockFinder } from "../Api-Riservi/JsonBlockFinder";
import { checkAvailability, createReservation, updateReservationById, cancelReservationById } from "../Api-Riservi/riservi";

function limpiarBloquesJSON(texto: string): string {
    return texto
        .replace(/\[JSON-DISPONIBLE\][\s\S]*?\[\/JSON-DISPONIBLE\]/g, "")
        .replace(/\[JSON-RESERVA\][\s\S]*?\[\/JSON-RESERVA\]/g, "")
        .replace(/\[JSON-MODIFICAR\][\s\S]*?\[\/JSON-MODIFICAR\]/g, "")
        .replace(/\[JSON-CANCELAR\][\s\S]*?\[\/JSON-CANCELAR\]/g, "");
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
        let jsonData: any = null;
        const textResponse = typeof response === "string" ? response : String(response || "");

        // 1) Intentar extraer bloque explícito
        const blockRegex = /\[(JSON-(DISPONIBLE|RESERVA|MODIFICAR|CANCELAR))\](.*?)\[\/\1\]/is;
        const match = textResponse.match(blockRegex);
        if (match) {
            const tipo = match[2];
            const jsonStr = match[3].trim();
            try {
                jsonData = JSON.parse(jsonStr);
                jsonData.type = `#${tipo.toUpperCase()}#`;
            } catch (e) {
                jsonData = null;
                if (ctx && ctx.type === 'webchat') {
                    console.log('[Webchat Debug] Failed to parse JSON block:', jsonStr);
                }
            }
        }

        // 2) Fallback heurístico
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
                const apiResponse = await checkAvailability(jsonData.date, jsonData.partySize, process.env.RESERVI_API_KEY);
                if (ctx && ctx.type === 'webchat') {
                    console.log('[Webchat Debug] checkAvailability response:', apiResponse);
                }
                let horariosDisponibles: string[] = [];
                if (apiResponse?.response?.availability) horariosDisponibles = apiResponse.response.availability.filter((s: any) => s.available).map((s: any) => s.time);
                const resumen = horariosDisponibles.length > 0 ? `Horarios disponibles para tu reserva: ${horariosDisponibles.join(", ")}` : "No hay horarios disponibles para la fecha y cantidad de personas solicitadas.";
                if (jsonData.date && jsonData.partySize) {
                    const pedirDatos = `Por favor, completa los datos restantes para la reserva del ${jsonData.date} para ${jsonData.partySize} personas (nombre, teléfono, email, etc).`;
                    const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, pedirDatos, state, undefined, ctx.from, ctx.from);
                    if (assistantApiResponse) await flowDynamic([{ body: limpiarBloquesJSON(String(assistantApiResponse)).trim() }]);
                    return;
                }
                const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, resumen, state, "Por favor, responde aunque sea brevemente.", ctx.from, ctx.from);
                if (assistantApiResponse) await flowDynamic([{ body: limpiarBloquesJSON(String(assistantApiResponse)).trim() }]);
                return;
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
                let apiResponse;
                try {
                    apiResponse = await createReservation(jsonData, process.env.RESERVI_API_KEY);
                    console.log('[Debug] RESERVA: Respuesta de createReservation:', apiResponse);
                } catch (err) {
                    console.error('[Debug] RESERVA: Error en createReservation:', err);
                }
                state.reservaEnCurso = false;
                // Limpiar el bloque y enviar solo el texto al usuario
                const cleanTextResponse = limpiarBloquesJSON(textResponse).trim();
                if (cleanTextResponse.length > 0) await flowDynamic([{ body: cleanTextResponse }]);
                // (Opcional) Enviar respuesta de la API al asistente si lo necesitas
                const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, typeof apiResponse === "string" ? apiResponse : JSON.stringify(apiResponse), state, undefined, ctx.from, ctx.from);
                if (assistantApiResponse) await flowDynamic([{ body: limpiarBloquesJSON(String(assistantApiResponse)).trim() }]);
                return;
            }

            if (tipo === "#MODIFICAR#") {
                const apiResponse = await updateReservationById(jsonData.id, jsonData.date, jsonData.partySize, process.env.RESERVI_API_KEY);
                if (ctx && ctx.type === 'webchat') {
                    console.log('[Webchat Debug] updateReservationById response:', apiResponse);
                }
                const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, typeof apiResponse === "string" ? apiResponse : JSON.stringify(apiResponse), state, undefined, ctx.from, ctx.from);
                if (assistantApiResponse) await flowDynamic([{ body: limpiarBloquesJSON(String(assistantApiResponse)).trim() }]);
                return;
            }

            if (tipo === "#CANCELAR#") {
                const apiResponse = await cancelReservationById(jsonData.id, process.env.RESERVI_API_KEY);
                if (ctx && ctx.type === 'webchat') {
                    console.log('[Webchat Debug] cancelReservationById response:', apiResponse);
                }
                const assistantApiResponse = await getAssistantResponse(ASSISTANT_ID, typeof apiResponse === "string" ? apiResponse : JSON.stringify(apiResponse), state, undefined, ctx.from, ctx.from);
                if (assistantApiResponse) await flowDynamic([{ body: limpiarBloquesJSON(String(assistantApiResponse)).trim() }]);
                return;
            }
        }

        // Si no hubo bloque JSON válido, enviar el texto limpio
        const cleanTextResponse = limpiarBloquesJSON(textResponse);
        if (cleanTextResponse.trim().length > 0) {
            const chunks = cleanTextResponse.split(/\n\n+/);
            for (const chunk of chunks) {
                if (chunk.trim().length > 0) {
                    await flowDynamic([{ body: chunk.trim() }]);
                }
            }
        }
    }
}

