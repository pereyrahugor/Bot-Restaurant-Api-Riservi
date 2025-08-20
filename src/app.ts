// ...existing imports y lógica del bot...

import path from 'path';
import { Server } from 'socket.io';
import fs from 'fs';
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
import { AssistantBridge } from './utils-web/AssistantBridge';
import { WebChatManager } from './utils-web/WebChatManager';
import { WebChatSession } from './utils-web/WebChatSession';
import { fileURLToPath } from 'url';
import { JsonBlockFinder } from "./Api-Riservi/JsonBlockFinder";
import { checkAvailability, createReservation, updateReservationById, cancelReservationById } from './Api-Riservi/riservi';
import { AssistantResponseProcessor } from "./utils/AssistantResponseProcessor";

// Definir __dirname para ES modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Instancia global de WebChatManager para sesiones webchat
const webChatManager = new WebChatManager();
// Eliminado: processUserMessageWeb. Usar lógica principal para ambos canales.

/** Puerto en el que se ejecutará el servidor (Railway usa 8080 por defecto) */
/** Puerto en el que se ejecutará el servidor */
const PORT = process.env.PORT ?? "";
/** ID del asistente de OpenAI */
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const ID_GRUPO_RESUMEN = process.env.ID_GRUPO_WS ?? "";

export const userQueues = new Map();
export const userLocks = new Map();

const adapterProvider = createProvider(BaileysProvider, {
    groupsIgnore: false,
    readStatus: false,
});

const errorReporter = new ErrorReporter(adapterProvider, ID_GRUPO_RESUMEN); // Reemplaza YOUR_GROUP_ID con el ID del grupo de WhatsApp

const TIMEOUT_MS = 120000;

// Control de timeout por usuario para evitar ejecuciones automáticas superpuestas
const userTimeouts = new Map();

// --- FUNCION DE REINTENTO PARA toAsk (manejo de run activo) ---
async function toAskWithRetry(assistantId, message, state, maxRetries = 5, delayMs = 20000) {
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

export const processUserMessage = async (
    ctx,
    { flowDynamic, state, provider, gotoFlow }
) => {
    await typing(ctx, provider);
    try {
        const response = await getAssistantResponse(ASSISTANT_ID, ctx.body, state, undefined, ctx.from, ctx.from);
        console.log('[DEBUG] Respuesta completa del asistente:', JSON.stringify(response, null, 2));
        if (!response) {
            await errorReporter.reportError(
                new Error("No se recibió respuesta del asistente."),
                ctx.from,
                `https://wa.me/${ctx.from}`
            );
        }
        await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
            response,
            ctx,
            flowDynamic,
            state,
            provider,
            gotoFlow,
            getAssistantResponse,
            ASSISTANT_ID
        );
        return state;
    } catch (error) {
        console.error("Error al procesar el mensaje del usuario:", error);
        await errorReporter.reportError(
            error,
            ctx.from,
            `https://wa.me/${ctx.from}`
        );
        if (ctx.type === EVENTS.VOICE_NOTE) {
            return gotoFlow(welcomeFlowVoice);
        } else {
            return gotoFlow(welcomeFlowTxt);
        }
    }
};

export const handleQueue = async (userId) => {
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

    // ...existing code...
                const adapterFlow = createFlow([welcomeFlowTxt, welcomeFlowVoice, welcomeFlowImg, idleFlow]);
                const adapterProvider = createProvider(BaileysProvider, {
                    groupsIgnore: false,
                    readStatus: false,
                });
                const adapterDB = new MemoryDB();
                const { httpServer } = await createBot({
                    flow: adapterFlow,
                    provider: adapterProvider,
                    database: adapterDB,
                });
                httpInject(adapterProvider.server);

                // Usar la instancia Polka (adapterProvider.server) para rutas
                const polkaApp = adapterProvider.server;
                // Agregar ruta personalizada para el webchat
                polkaApp.get('/webchat', (req, res) => {
                    res.sendFile(path.join(__dirname, '../webchat.html'));
                });

                // Obtener el servidor HTTP real de BuilderBot después de httpInject
                const realHttpServer = adapterProvider.server.server;

                // Integrar Socket.IO sobre el servidor HTTP real de BuilderBot
                const io = new Server(realHttpServer, { cors: { origin: '*' } });
                io.on('connection', (socket) => {
                    console.log('💬 Cliente web conectado');
                    socket.on('message', async (msg) => {
                        try {
                            let ip = '';
                            const xff = socket.handshake.headers['x-forwarded-for'];
                            if (typeof xff === 'string') {
                                ip = xff.split(',')[0];
                            } else if (Array.isArray(xff)) {
                                ip = xff[0];
                            } else {
                                ip = socket.handshake.address || '';
                            }
                            if (!global.webchatHistories) global.webchatHistories = {};
                            const historyKey = `webchat_${ip}`;
                            if (!global.webchatHistories[historyKey]) global.webchatHistories[historyKey] = [];
                            const _history = global.webchatHistories[historyKey];
                            const state = {
                                get: function (key) {
                                    if (key === 'history') return _history;
                                    return undefined;
                                },
                                update: async function (msg, role = 'user') {
                                    if (_history.length > 0) {
                                        const last = _history[_history.length - 1];
                                        if (last.role === role && last.content === msg) return;
                                    }
                                    _history.push({ role, content: msg });
                                    if (_history.length >= 6) {
                                        const last3 = _history.slice(-3);
                                        if (last3.every(h => h.role === 'user' && h.content === msg)) {
                                            _history.length = 0;
                                        }
                                    }
                                },
                                clear: async function () { _history.length = 0; }
                            };
                            const provider = undefined;
                            const gotoFlow = () => {};
                            let replyText = '';
                            const flowDynamic = async (arr) => {
                                if (Array.isArray(arr)) {
                                    replyText = arr.map(a => a.body).join('\n');
                                } else if (typeof arr === 'string') {
                                    replyText = arr;
                                }
                            };
                            if (msg.trim().toLowerCase() === "#reset" || msg.trim().toLowerCase() === "#cerrar") {
                                await state.clear();
                                replyText = "🔄 El chat ha sido reiniciado. Puedes comenzar una nueva conversación.";
                            } else {
                                // Obtener respuesta del asistente
                                const response = await getAssistantResponse(ASSISTANT_ID, msg, state, undefined, ip, ip);
                                // Procesar y limpiar la respuesta igual que WhatsApp
                                await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                                    response,
                                    { from: ip, body: msg, type: 'webchat' },
                                    flowDynamic,
                                    state,
                                    provider,
                                    gotoFlow,
                                    getAssistantResponse,
                                    ASSISTANT_ID
                                );
                            }
                            socket.emit('reply', replyText);
                        } catch (err) {
                            console.error('Error procesando mensaje webchat:', err);
                            socket.emit('reply', 'Hubo un error procesando tu mensaje.');
                        }
                    });
                });

                // Agregar ruta personalizada para el webchat
                polkaApp.get('/webchat', (req, res) => {
                    res.setHeader('Content-Type', 'text/html');
                    res.end(fs.readFileSync(path.join(__dirname, '../webchat.html')));
                });

                // Integrar AssistantBridge si es necesario
                const assistantBridge = new AssistantBridge();
                assistantBridge.setupWebChat(polkaApp, realHttpServer);

                                polkaApp.post('/webchat-api', async (req, res) => {
                                    console.log('Llamada a /webchat-api'); // log para debug
                                    // Si el body ya está disponible (por ejemplo, con body-parser), úsalo directamente
                                    if (req.body && req.body.message) {
                                        console.log('Body recibido por body-parser:', req.body); // debug
                                        try {
                                            const message = req.body.message;
                                            console.log('Mensaje recibido en webchat:', message); // debug
                                            let ip = '';
                                            const xff = req.headers['x-forwarded-for'];
                                            if (typeof xff === 'string') {
                                                ip = xff.split(',')[0];
                                            } else if (Array.isArray(xff)) {
                                                ip = xff[0];
                                            } else {
                                                ip = req.socket.remoteAddress || '';
                                            }
                                            // Crear un ctx similar al de WhatsApp, usando el IP como 'from'
                                            const ctx = {
                                                from: ip,
                                                body: message,
                                                type: 'webchat',
                                                // Puedes agregar más propiedades si tu lógica lo requiere
                                            };
                                            // Usar la lógica principal del bot (processUserMessage)
                                            let replyText = '';
                                            // Simular flowDynamic para capturar la respuesta
                                            const flowDynamic = async (arr) => {
                                                if (Array.isArray(arr)) {
                                                    replyText = arr.map(a => a.body).join('\n');
                                                } else if (typeof arr === 'string') {
                                                    replyText = arr;
                                                }
                                            };
                                                // Usar WebChatManager y WebChatSession para gestionar la sesión webchat
                                                const { getOrCreateThreadId, sendMessageToThread, deleteThread } = await import('./utils-web/openaiThreadBridge');
                                                const session = webChatManager.getSession(ip);
                                                if (message.trim().toLowerCase() === "#reset" || message.trim().toLowerCase() === "#cerrar") {
                                                    await deleteThread(session);
                                                    session.clear();
                                                    replyText = "🔄 El chat ha sido reiniciado. Puedes comenzar una nueva conversación.";
                                                } else {
                                                    session.addUserMessage(message);
                                                    const threadId = await getOrCreateThreadId(session);
                                                    const reply = await sendMessageToThread(threadId, message, ASSISTANT_ID);
                                                    session.addAssistantMessage(reply);
                                                    replyText = reply;
                                            }
                                            res.setHeader('Content-Type', 'application/json');
                                            res.end(JSON.stringify({ reply: replyText }));
                                        } catch (err) {
                                            console.error('Error en /webchat-api:', err); // debug
                                            res.statusCode = 500;
                                            res.end(JSON.stringify({ reply: 'Hubo un error procesando tu mensaje.' }));
                                        }
                                    } else {
                                        // Fallback manual si req.body no está disponible
                                        let body = '';
                                        req.on('data', chunk => { body += chunk; });
                                        req.on('end', async () => {
                                            console.log('Body recibido en /webchat-api:', body); // log para debug
                                            try {
                                                const { message } = JSON.parse(body);
                                                console.log('Mensaje recibido en webchat:', message); // debug
                                                let ip = '';
                                                const xff = req.headers['x-forwarded-for'];
                                                if (typeof xff === 'string') {
                                                    ip = xff.split(',')[0];
                                                } else if (Array.isArray(xff)) {
                                                    ip = xff[0];
                                                } else {
                                                    ip = req.socket.remoteAddress || '';
                                                }
                                                // Centralizar historial y estado igual que WhatsApp
                                                if (!global.webchatHistories) global.webchatHistories = {};
                                                const historyKey = `webchat_${ip}`;
                                                if (!global.webchatHistories[historyKey]) global.webchatHistories[historyKey] = { history: [], thread_id: null };
                                                const _store = global.webchatHistories[historyKey];
                                                const _history = _store.history;
                                                const state = {
                                                    get: function (key) {
                                                        if (key === 'history') return _history;
                                                        if (key === 'thread_id') return _store.thread_id;
                                                        return undefined;
                                                    },
                                                    setThreadId: function (id) {
                                                        _store.thread_id = id;
                                                    },
                                                    update: async function (msg, role = 'user') {
                                                        if (_history.length > 0) {
                                                            const last = _history[_history.length - 1];
                                                            if (last.role === role && last.content === msg) return;
                                                        }
                                                        _history.push({ role, content: msg });
                                                        if (_history.length >= 6) {
                                                            const last3 = _history.slice(-3);
                                                            if (last3.every(h => h.role === 'user' && h.content === msg)) {
                                                                _history.length = 0;
                                                                _store.thread_id = null;
                                                            }
                                                        }
                                                    },
                                                    clear: async function () { _history.length = 0; _store.thread_id = null; }
                                                };
                                                const provider = undefined;
                                                const gotoFlow = () => {};
                                                let replyText = '';
                                                const flowDynamic = async (arr) => {
                                                    if (Array.isArray(arr)) {
                                                        replyText = arr.map(a => a.body).join('\n');
                                                    } else if (typeof arr === 'string') {
                                                        replyText = arr;
                                                    }
                                                };
                                                if (message.trim().toLowerCase() === "#reset" || message.trim().toLowerCase() === "#cerrar") {
                                                    await state.clear();
                                                    replyText = "🔄 El chat ha sido reiniciado. Puedes comenzar una nueva conversación.";
                                                } else {
                                                    // ...thread_id gestionado por openaiThreadBridge, no es necesario actualizar aquí...
                                                }
                                                res.setHeader('Content-Type', 'application/json');
                                                res.end(JSON.stringify({ reply: replyText }));
                                            } catch (err) {
                                                console.error('Error en /webchat-api:', err); // debug
                                                res.statusCode = 500;
                                                res.end(JSON.stringify({ reply: 'Hubo un error procesando tu mensaje.' }));
                                            }
                                        });
                                    }
                                });

            // No llamar a listen, BuilderBot ya inicia el servidor
 

    // Paso 10: Inyectar el servidor HTTP para el proveedor
    httpInject(adapterProvider.server);
    // Paso 11: Iniciar el servidor HTTP en el puerto especificado
    httpServer(+PORT);
};

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

main();
