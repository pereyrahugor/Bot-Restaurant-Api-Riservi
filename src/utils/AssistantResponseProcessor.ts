// src/utils/AssistantResponseProcessor.ts
import { JsonBlockFinder } from "../Api-Riservi/JsonBlockFinder";
import { checkAvailability, createReservation, updateReservationById, cancelReservationById } from "../Api-Riservi/riservi";

function limpiarBloquesJSON(texto: string): string {
    return texto.replace(/\[JSON-DISPONIBLE\][\s\S]*?\[\/JSON-DISPONIBLE\]/g, '').replace(/\[JSON-RESERVA\][\s\S]*?\[\/JSON-RESERVA\]/g, '');
}

function corregirFechaAnioVigente(fechaReservaStr: string): string {
    const ahora = new Date();
    const vigente = ahora.getFullYear();
    const [fecha, hora] = fechaReservaStr.split(' ');
    const [anioRaw, mes, dia] = fecha.split('-').map(Number);
    let anio = anioRaw;
    if (anio < vigente) {
        anio = vigente;
    }
    return `${anio.toString().padStart(4, '0')}-${mes.toString().padStart(2, '0')}-${dia.toString().padStart(2, '0')} ${hora}`;
}

function esFechaFutura(fechaReservaStr: string): boolean {
    const ahora = new Date();
    const fechaReserva = new Date(fechaReservaStr.replace(' ', 'T'));
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
        let jsonData = null;
        const textResponse = typeof response === "string" ? response : String(response);
        const jsonDisponibleMatch = textResponse.match(/\[JSON-DISPONIBLE\]([\s\S]*?)\[\/JSON-DISPONIBLE\]/);
        const jsonReservaMatch = textResponse.match(/\[JSON-RESERVA\]([\s\S]*?)\[\/JSON-RESERVA\]/);
        const jsonModificarMatch = textResponse.match(/\[JSON-MODIFICAR\]([\s\S]*?)\[\/JSON-MODIFICAR\]/);
        const jsonCancelarMatch = textResponse.match(/\[JSON-CANCELAR\]([\s\S]*?)\[\/JSON-CANCELAR\]/);
        if (jsonDisponibleMatch) {
            try {
                jsonData = JSON.parse(jsonDisponibleMatch[1]);
            } catch (e) { jsonData = null; }
        } else if (jsonReservaMatch) {
            try {
                jsonData = JSON.parse(jsonReservaMatch[1]);
            } catch (e) { jsonData = null; }
        } else if (jsonModificarMatch) {
            try {
                jsonData = JSON.parse(jsonModificarMatch[1]);
            } catch (e) { jsonData = null; }
        } else if (jsonCancelarMatch) {
            try {
                jsonData = JSON.parse(jsonCancelarMatch[1]);
            } catch (e) { jsonData = null; }
        }
        if (!jsonData) {
            jsonData = JsonBlockFinder.buscarBloquesJSONEnTexto(textResponse);
            if (!jsonData && typeof response === 'object') {
                jsonData = JsonBlockFinder.buscarBloquesJSONProfundo(response);
            }
        }
        if (jsonData) {
            if (jsonData.type === "#DISPONIBLE#") {
                const fechaOriginal = jsonData.date;
                const fechaCorregida = corregirFechaAnioVigente(fechaOriginal);
                if (fechaOriginal !== fechaCorregida) {
                    jsonData.date = fechaCorregida;
                }
                if (!esFechaFutura(jsonData.date)) {
                    const mensaje = 'La fecha debe ser igual o posterior a hoy. Por favor, elegí una fecha válida.';
                    await flowDynamic([{ body: mensaje }]);
                    return;
                }
                const apiResponse = await checkAvailability(
                    jsonData.date,
                    jsonData.partySize,
                    process.env.RESERVI_API_KEY
                );
                let horariosDisponibles = [];
                if (apiResponse?.response?.availability) {
                    horariosDisponibles = apiResponse.response.availability
                        .filter(slot => slot.available)
                        .map(slot => slot.time);
                }
                let resumen;
                if (horariosDisponibles.length > 0) {
                    resumen = `Horarios disponibles para tu reserva: ${horariosDisponibles.join(', ')}`;
                } else {
                    resumen = "No hay horarios disponibles para la fecha y cantidad de personas solicitadas.";
                }
                if (jsonData.date && jsonData.partySize) {
                    const pedirDatos = `Por favor, completa los datos restantes para la reserva del ${jsonData.date} para ${jsonData.partySize} personas (nombre, teléfono, email, etc).`;
                    const assistantApiResponse = await getAssistantResponse(
                        ASSISTANT_ID,
                        pedirDatos,
                        state,
                        undefined,
                        ctx.from,
                        ctx.from
                    );
                    if (assistantApiResponse) {
                        const cleanText = limpiarBloquesJSON(String(assistantApiResponse));
                        await flowDynamic([{ body: cleanText.trim() }]);
                    }
                    return;
                }
                const assistantApiResponse = await getAssistantResponse(
                    ASSISTANT_ID,
                    resumen,
                    state,
                    "Por favor, responde aunque sea brevemente.",
                    ctx.from,
                    ctx.from
                );
                if (assistantApiResponse) {
                    const cleanText = limpiarBloquesJSON(String(assistantApiResponse));
                    await flowDynamic([{ body: cleanText.trim() }]);
                }
                return;
            } else if (jsonData.type === "#RESERVA#") {
                const fechaOriginal = jsonData.date;
                const fechaCorregida = corregirFechaAnioVigente(fechaOriginal);
                if (fechaOriginal !== fechaCorregida) {
                    jsonData.date = fechaCorregida;
                }
                if (!esFechaFutura(jsonData.date)) {
                    const mensaje = 'La fecha debe ser igual o posterior a hoy. Por favor, elegí una fecha válida.';
                    await flowDynamic([{ body: mensaje }]);
                    return;
                }
                const apiResponse = await createReservation(
                    jsonData,
                    process.env.RESERVI_API_KEY
                );
                const assistantApiResponse = await getAssistantResponse(
                    ASSISTANT_ID,
                    typeof apiResponse === 'string' ? apiResponse : JSON.stringify(apiResponse),
                    state,
                    undefined,
                    ctx.from,
                    ctx.from
                );
                if (assistantApiResponse) {
                    const cleanText = limpiarBloquesJSON(String(assistantApiResponse));
                    await flowDynamic([{ body: cleanText.trim() }]);
                }
                return;
            } else if (jsonData.type === "#MODIFICAR#") {
                const apiResponse = await updateReservationById(
                    jsonData.id,
                    jsonData.date,
                    jsonData.partySize,
                    process.env.RESERVI_API_KEY
                );
                const assistantApiResponse = await getAssistantResponse(
                    ASSISTANT_ID,
                    typeof apiResponse === 'string' ? apiResponse : JSON.stringify(apiResponse),
                    state,
                    undefined,
                    ctx.from,
                    ctx.from
                );
                if (assistantApiResponse) {
                    const cleanText = limpiarBloquesJSON(String(assistantApiResponse));
                    await flowDynamic([{ body: cleanText.trim() }]);
                }
                return;
            } else if (jsonData.type === "#CANCELAR#") {
                const apiResponse = await cancelReservationById(
                    jsonData.id,
                    process.env.RESERVI_API_KEY
                );
                const assistantApiResponse = await getAssistantResponse(
                    ASSISTANT_ID,
                    typeof apiResponse === 'string' ? apiResponse : JSON.stringify(apiResponse),
                    state,
                    undefined,
                    ctx.from,
                    ctx.from
                );
                if (assistantApiResponse) {
                    const cleanText = limpiarBloquesJSON(String(assistantApiResponse));
                    await flowDynamic([{ body: cleanText.trim() }]);
                }
                return;
            }
        }
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
