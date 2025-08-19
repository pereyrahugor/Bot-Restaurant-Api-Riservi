import "dotenv/config";
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from "@builderbot/bot";
import { MemoryDB } from "@builderbot/bot";
import { BaileysProvider } from "@builderbot/provider-baileys";
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";
import { idleFlow } from "./Flows/idleFlow";
import { welcomeFlowTxt } from "./Flows/welcomeFlowTxt";
import { welcomeFlowVoice } from "./Flows/welcomeFlowVoice";
import { welcomeFlowImg } from "./Flows/welcomeFlowImg";
import { ErrorReporter } from "./utils/errorReporter";
import { checkAvailability, createReservation, updateReservationById, cancelReservationById } from './Api-Riservi/riservi';
import { JsonBlockFinder } from './Api-Riservi/JsonBlockFinder';

/** Puerto en el que se ejecutará el servidor */
const PORT = process.env.PORT ?? "";
/** ID del asistente de OpenAI */
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const ID_GRUPO_RESUMEN = process.env.ID_GRUPO_WS ?? "";

const userQueues = new Map();
const userLocks = new Map();

const adapterProvider = createProvider(BaileysProvider, {
    groupsIgnore: false,
    readStatus: false,
});

const errorReporter = new ErrorReporter(adapterProvider, ID_GRUPO_RESUMEN); // Reemplaza YOUR_GROUP_ID con el ID del grupo de WhatsApp

const TIMEOUT_MS = 120000;

// Control de timeout por usuario para evitar ejecuciones automáticas superpuestas
const userTimeouts = new Map();

// --- FUNCION DE REINTENTO PARA toAsk (manejo de run activo) ---
async function toAskWithRetry(assistantId, message, state, maxRetries = 5, delayMs = 2000) {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            return await toAsk(assistantId, message, state);
        } catch (error) {
            if (
                error?.message?.includes("Can't add messages to thread") &&
                error?.status === 400
            ) {
                // Espera y reintenta
                await new Promise(res => setTimeout(res, delayMs));
                attempt++;
                continue;
            }
            throw error; // Otros errores, no reintentar
        }
    }
    throw new Error("No se pudo enviar el mensaje a OpenAI Assistant tras varios intentos.");
}

const getAssistantResponse = async (assistantId, message, state, fallbackMessage, userId, userPhone) => {
    // Si hay un timeout previo, lo limpiamos
    if (userTimeouts.has(userId)) {
        clearTimeout(userTimeouts.get(userId));
        userTimeouts.delete(userId);
    }

    // Agregar fecha y hora actual y número de contacto como contexto para el asistente
    const currentDatetime = new Date().toISOString();
    let systemPrompt = '';
    if (fallbackMessage) systemPrompt += fallbackMessage + '\n';
    systemPrompt += `Fecha y hora actual de referencia para el asistente: ${currentDatetime}`;
    if (userPhone) systemPrompt += `\nNúmero de contacto del usuario: ${userPhone}`;

    let timeoutResolve;
    const timeoutPromise = new Promise((resolve) => {
        timeoutResolve = resolve;
        const timeoutId = setTimeout(() => {
            console.warn("⏱ Timeout alcanzado. Reintentando con mensaje de control...");
            resolve(toAskWithRetry(assistantId, systemPrompt, state));
            userTimeouts.delete(userId);
        }, TIMEOUT_MS);
        userTimeouts.set(userId, timeoutId);
    });

    // Lanzamos la petición a OpenAI con reintentos
    const askPromise = toAskWithRetry(assistantId, systemPrompt + "\n" + message, state).then((result) => {
        // Si responde antes del timeout, limpiamos el timeout
        if (userTimeouts.has(userId)) {
            clearTimeout(userTimeouts.get(userId));
            userTimeouts.delete(userId);
        }
        // Resolvemos el timeout para evitar que quede pendiente
        timeoutResolve(result);
        return result;
    });

    // El primero que responda (OpenAI o timeout) gana
    return Promise.race([askPromise, timeoutPromise]);
};

const processUserMessage = async (
    ctx,
    { flowDynamic, state, provider, gotoFlow }
) => {
    await typing(ctx, provider);
    try {

        // const response = await toAsk(ASSISTANT_ID, ctx.body, state);
        const response = await getAssistantResponse(ASSISTANT_ID, ctx.body, state, undefined, ctx.from, ctx.from);

        // Log para depuración: mostrar el contenido completo de la respuesta del asistente
        console.log('[DEBUG] Respuesta completa del asistente:', JSON.stringify(response, null, 2));

        if (!response) {
            // Enviar reporte de error al grupo de WhatsApp
            await errorReporter.reportError(
                new Error("No se recibió respuesta del asistente."),
                ctx.from,
                `https://wa.me/${ctx.from}`
            );
        }

        // --- INICIO FLUJO RISERVI Y LIMPIEZA ANTES DE CHUNKS ---
        // Buscar y procesar bloques JSON antes de cualquier envío al usuario
        let jsonData = null;
        const responseAny = response as any;
        const textResponse = typeof response === "string" ? response : String(response);
        // --- FUNCIONES AUXILIARES PARA DETECCIÓN DE BLOQUES JSON ---
        const jsonDisponibleMatch = textResponse.match(/\[JSON-DISPONIBLE\]([\s\S]*?)\[\/JSON-DISPONIBLE\]/);
        const jsonReservaMatch = textResponse.match(/\[JSON-RESERVA\]([\s\S]*?)\[\/JSON-RESERVA\]/);
        const jsonModificarMatch = textResponse.match(/\[JSON-MODIFICAR\]([\s\S]*?)\[\/JSON-MODIFICAR\]/);
        const jsonCancelarMatch = textResponse.match(/\[JSON-CANCELAR\]([\s\S]*?)\[\/JSON-CANCELAR\]/);
        // --- LOG EXTRA PARA DEPURACIÓN DE BLOQUES JSON ---
        console.log('[DEBUG] textResponse recibido para análisis de etiquetas:', textResponse);
        if (jsonDisponibleMatch) {
            console.log('[DEBUG] Match [JSON-DISPONIBLE]:', jsonDisponibleMatch[1]);
        }
        if (jsonReservaMatch) {
            console.log('[DEBUG] Match [JSON-RESERVA]:', jsonReservaMatch[1]);
        }
        if (jsonDisponibleMatch) {
            try {
                jsonData = JSON.parse(jsonDisponibleMatch[1]);
                console.log('[RISERVI] JSON detectado entre etiquetas DISPONIBLE:', JSON.stringify(jsonData));
            } catch (e) {
                console.error('[RISERVI] Error al parsear JSON-DISPONIBLE:', e, jsonDisponibleMatch[1]);
                return state;
            }
        } else if (jsonReservaMatch) {
            try {
                jsonData = JSON.parse(jsonReservaMatch[1]);
                console.log('[RISERVI] JSON detectado entre etiquetas RESERVA:', JSON.stringify(jsonData));
            } catch (e) {
                console.error('[RISERVI] Error al parsear JSON-RESERVA:', e, '\nContenido del bloque:', jsonReservaMatch[1]);
                return state;
            }
        } else if (jsonModificarMatch) {
            try {
                jsonData = JSON.parse(jsonModificarMatch[1]);
                console.log('[RISERVI] JSON detectado entre etiquetas MODIFICAR:', JSON.stringify(jsonData));
            } catch (e) {
                console.error('[RISERVI] Error al parsear JSON-MODIFICAR:', e, jsonModificarMatch[1]);
                return state;
            }
        } else if (jsonCancelarMatch) {
            try {
                jsonData = JSON.parse(jsonCancelarMatch[1]);
                console.log('[RISERVI] JSON detectado entre etiquetas CANCELAR:', JSON.stringify(jsonData));
            } catch (e) {
                console.error('[RISERVI] Error al parsear JSON-CANCELAR:', e, jsonCancelarMatch[1]);
                return state;
            }
        }
        // Si no se detectó bloque entre etiquetas, buscar cualquier bloque JSON válido en el texto (robusto para variables Python, bloques sueltos, etc)
        if (!jsonData) {
            // Busca en el texto plano
            jsonData = JsonBlockFinder.buscarBloquesJSONEnTexto(textResponse);
            // Si no se encontró, busca en todas las propiedades string del objeto de respuesta
            if (!jsonData && typeof response === 'object') {
                jsonData = JsonBlockFinder.buscarBloquesJSONProfundo(response);
                if (jsonData) {
                    console.log('[RISERVI] JSON detectado en objeto anidado:', JSON.stringify(jsonData));
                }
            }
        }
        if (jsonData) {
            if (jsonData.type === "#DISPONIBLE#") {
                // Corrección automática de año si es menor al vigente
                const fechaOriginal = jsonData.date;
                const fechaCorregida = corregirFechaAnioVigente(fechaOriginal);
                if (fechaOriginal !== fechaCorregida) {
                    jsonData.date = fechaCorregida;
                    // Eliminado: notificación al usuario sobre corrección de año
                }
                if (!esFechaFutura(jsonData.date)) {
                    const mensaje = 'La fecha debe ser igual o posterior a hoy. Por favor, elegí una fecha válida.';
                    await flowDynamic([{ body: mensaje }]);
                    return state;
                }
                console.log('[RISERVI] Ejecutando checkAvailability con:', jsonData.date, jsonData.partySize);
                const apiResponse = await checkAvailability(
                    jsonData.date,
                    jsonData.partySize,
                    process.env.RESERVI_API_KEY
                );
                console.log('[RISERVI] Respuesta de checkAvailability:', JSON.stringify(apiResponse));

                // --- NUEVO: Extraer solo horarios disponibles ---
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

                // Si el usuario eligió un horario alternativo, pedir al asistente que complete los datos restantes
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
                    return state;
                }

                // Enviar solo el resumen al asistente (caso general)
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
                return state;
            } else if (jsonData.type === "#RESERVA#") {
                // Corrección automática de año si es menor al vigente
                const fechaOriginal = jsonData.date;
                const fechaCorregida = corregirFechaAnioVigente(fechaOriginal);
                if (fechaOriginal !== fechaCorregida) {
                    jsonData.date = fechaCorregida;
                    // Eliminado: notificación al usuario sobre corrección de año
                }
                if (!esFechaFutura(jsonData.date)) {
                    const mensaje = 'La fecha debe ser igual o posterior a hoy. Por favor, elegí una fecha válida.';
                    await flowDynamic([{ body: mensaje }]);
                    return state;
                }
                console.log('[RISERVI] Ejecutando createReservation con:', JSON.stringify(jsonData));
                const apiResponse = await createReservation(
                    jsonData,
                    process.env.RESERVI_API_KEY
                );
                console.log('[RISERVI] Respuesta de createReservation:', JSON.stringify(apiResponse));
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
                return state;
            } else if (jsonData.type === "#MODIFICAR#") {
                // Implementación del método de modificación de reserva
                // No se modifica la lógica, solo se llama al método
                const apiResponse = await updateReservationById(
                    jsonData.id,
                    jsonData.date,
                    jsonData.partySize,
                    process.env.RESERVI_API_KEY
                );
                console.log('[RISERVI] Respuesta de updateReservationById:', JSON.stringify(apiResponse));
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
                return state;
            } else if (jsonData.type === "#CANCELAR#") {
                // Implementación del método de cancelación de reserva
                // No se modifica la lógica, solo se llama al método
                const apiResponse = await cancelReservationById(
                    jsonData.id,
                    process.env.RESERVI_API_KEY
                );
                console.log('[RISERVI] Respuesta de cancelReservationById:', JSON.stringify(apiResponse));
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
                return state;
            }
        }
        // --- FIN FLUJO RISERVI Y LIMPIEZA ANTES DE CHUNKS ---

        // --- LIMPIEZA DE BLOQUES JSON EN TODA RESPUESTA ---
        const cleanTextResponse = limpiarBloquesJSON(textResponse);
        if (cleanTextResponse.trim().length > 0) {
            const chunks = cleanTextResponse.split(/\n\n+/);
            for (const chunk of chunks) {
                if (chunk.trim().length > 0) {
                    await flowDynamic([{ body: chunk.trim() }]);
                }
            }
        }
        return state;
    } catch (error) {
        console.error("Error al procesar el mensaje del usuario:", error);

        // Enviar reporte de error al grupo de WhatsApp
        await errorReporter.reportError(
            error,
            ctx.from,
            `https://wa.me/${ctx.from}`
        );

        // 📌 Manejo de error: volver al flujo adecuado
        if (ctx.type === EVENTS.VOICE_NOTE) {
            return gotoFlow(welcomeFlowVoice);
        } else {
            return gotoFlow(welcomeFlowTxt);
        }
    }
};


const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);

    if (userLocks.get(userId)) return;

    userLocks.set(userId, true);

    while (queue.length > 0) {
        const { ctx, flowDynamic, state, provider, gotoFlow } = queue.shift();
        try {
            await processUserMessage(ctx, { flowDynamic, state, provider, gotoFlow });
        } catch (error) {
            console.error(`Error procesando el mensaje de ${userId}:`, error);
        }
    }

    userLocks.set(userId, false);
    userQueues.delete(userId);
};

// Main function to initialize the bot and load Google Sheets data
const main = async () => {

    // Paso 6: Crear el flujo principal del bot
    const adapterFlow = createFlow([welcomeFlowTxt, welcomeFlowVoice, welcomeFlowImg, idleFlow]);
    // Paso 7: Crear el proveedor de WhatsApp (Baileys)
    const adapterProvider = createProvider(BaileysProvider, {
        groupsIgnore: false,
        readStatus: false,
    });
    // Paso 8: Crear la base de datos en memoria
    const adapterDB = new MemoryDB();
    // Paso 9: Inicializar el bot con los flujos, proveedor y base de datos
    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    // Paso 10: Inyectar el servidor HTTP para el proveedor
    httpInject(adapterProvider.server);
    // Paso 11: Iniciar el servidor HTTP en el puerto especificado
    httpServer(+PORT);
};

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// --- FUNCION DE LIMPIEZA DE BLOQUES JSON ---
function limpiarBloquesJSON(texto) {
    return texto.replace(/\[JSON-DISPONIBLE\][\s\S]*?\[\/JSON-DISPONIBLE\]/g, '').replace(/\[JSON-RESERVA\][\s\S]*?\[\/JSON-RESERVA\]/g, '');
}

// --- FUNCION DE VALIDACION Y CORRECCION DE FECHA FUTURA ---
function corregirFechaAnioVigente(fechaReservaStr) {
    // Si el año es menor al actual, lo actualiza al año vigente
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

function esFechaFutura(fechaReservaStr) {
    const ahora = new Date();
    const fechaReserva = new Date(fechaReservaStr.replace(' ', 'T'));
    return fechaReserva >= ahora;
}

export { welcomeFlowTxt, welcomeFlowVoice, welcomeFlowImg,
    handleQueue, userQueues, userLocks,
 };

main();