import path from "path";
import serve from "serve-static";
import { Server } from "socket.io";
import fs from "fs";
import bodyParser from 'body-parser';
import "dotenv/config";
import {
  createBot,
  createProvider,
  createFlow,
  addKeyword,
  EVENTS,
} from "@builderbot/bot";
import { MemoryDB } from "@builderbot/bot";
import { YCloudProvider } from "./providers/YCloudProvider";
import { BaileysProvider } from "builderbot-provider-sherpa";
import { adapterProvider, groupProvider, setAdapterProvider, setGroupProvider } from "./providers/instances";
import { restoreSessionFromDb, startSessionSync, deleteSessionFromDb, isSessionInDb } from "./utils/sessionSync";
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants";
import { typing } from "./utils/presence";
import QRCode from 'qrcode';
import { idleFlow } from "./Flows/idleFlow";
import { welcomeFlowTxt } from "./Flows/welcomeFlowTxt";
import { welcomeFlowVoice } from "./Flows/welcomeFlowVoice";
import { welcomeFlowImg } from "./Flows/welcomeFlowImg";
import { ErrorReporter } from "./utils/errorReporter";
import { AssistantBridge } from "./utils-web/AssistantBridge";
import { WebChatManager } from "./utils-web/WebChatManager";
import { fileURLToPath } from "url";
import { AssistantResponseProcessor } from "./utils/AssistantResponseProcessor";
import { getArgentinaDatetimeString } from "./utils/ArgentinaTime";
import { RailwayApi } from "./Api-RailWay/Railway";

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
const ID_GRUPO_RESUMEN = process.env.ID_GRUPO_RESUMEN ?? "";

// Estado global para encender/apagar el bot
let botEnabled = true;

export const userQueues = new Map();
export const userLocks = new Map();

let errorReporter;

// Función auxiliar para verificar el estado de ambos proveedores
const getBotStatus = async () => {
    try {
        // 1. Estado YCloud (Meta)
        const ycloudConfigured = !!(process.env.YCLOUD_API_KEY && process.env.YCLOUD_WABA_NUMBER);
        
        // 2. Estado Motor de Grupos (Baileys)
        const groupsReady = !!(groupProvider?.vendor?.user || groupProvider?.globalVendorArgs?.sock?.user);
        
        const sessionsDir = path.join(process.cwd(), 'bot_sessions');
        let groupsLocalActive = false;
        if (fs.existsSync(sessionsDir)) {
            const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
            groupsLocalActive = files.includes('creds.json');
        }

        const groupsRemoteActive = await isSessionInDb('groups');

        return {
            ycloud: {
                active: ycloudConfigured,
                status: ycloudConfigured ? 'connected' : 'error',
                phoneNumber: process.env.YCLOUD_WABA_NUMBER || null
            },
            groups: {
                initialized: !!groupProvider,
                active: groupsReady,
                source: groupsReady ? 'connected' : (groupsLocalActive ? 'local' : 'none'),
                hasRemote: groupsRemoteActive,
                qr: fs.existsSync(path.join(process.cwd(), 'bot.groups.qr.png')),
                phoneNumber: groupProvider?.vendor?.user?.id?.split(':')[0] || null
            }
        };
    } catch (e) {
        console.error('[Status] Error obteniendo estado:', e);
        return { error: String(e) };
    }
};

const TIMEOUT_MS = 120000;

// Control de timeout por usuario para evitar ejecuciones automáticas superpuestas
const userTimeouts = new Map();

// --- FUNCION DE REINTENTO PARA toAsk (manejo de run activo) ---
async function toAskWithRetry(
  assistantId,
  message,
  state,
  maxRetries = 5,
  delayMs = 20000
) {
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
        await new Promise((res) => setTimeout(res, delayMs));
        attempt++;
        continue;
      }
      throw error; // Otros errores, no reintentar
    }
  }
  throw new Error(
    "No se pudo enviar el mensaje a OpenAI Assistant tras varios intentos."
  );
}

const getAssistantResponse = async (
  assistantId,
  message,
  state,
  fallbackMessage,
  userId,
  userPhone
) => {
  // Si hay un timeout previo, lo limpiamos
  if (userTimeouts.has(userId)) {
    clearTimeout(userTimeouts.get(userId));
    userTimeouts.delete(userId);
  }

  // Agregar fecha y hora actual y número de contacto como contexto para el asistente
  const currentDatetimeArg = getArgentinaDatetimeString();
  console.log(
    "[DEBUG] Fecha y hora actual (GMT-3) enviada al asistente:",
    currentDatetimeArg
  );
  let systemPrompt = "";
  if (fallbackMessage) systemPrompt += fallbackMessage + "\n";
  systemPrompt += `Fecha, hora y día de la semana de referencia para el asistente: ${currentDatetimeArg}`;
  if (userPhone)
    systemPrompt += `\nNúmero de contacto del usuario: ${userPhone}`;

  let timeoutResolve;
  const timeoutPromise = new Promise((resolve) => {
    timeoutResolve = resolve;
    const timeoutId = setTimeout(() => {
      console.warn(
        "⏱ Timeout alcanzado. Reintentando con mensaje de control..."
      );
      resolve(toAskWithRetry(assistantId, systemPrompt, state));
      userTimeouts.delete(userId);
    }, TIMEOUT_MS);
    userTimeouts.set(userId, timeoutId);
  });

  // Lanzamos la petición a OpenAI con reintentos
  const askPromise = toAskWithRetry(
    assistantId,
    systemPrompt + "\n" + message,
    state
  ).then((result) => {
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
  const userId = ctx.from;
  console.log(`[processUserMessage] 📬 Procesando mensaje de ${userId}: "${ctx.body}"`);
  const botNumber = (process.env.YCLOUD_WABA_NUMBER || '').replace(/\D/g, '');
  
  // FILTRO DE SEGURIDAD: Evitar que el bot procese sus propios mensajes de eco
  if (userId.replace(/\D/g, '') === botNumber) {
      const { stop } = await import('./utils/timeOut');
      stop(ctx); // Detenemos cualquier timer de inactividad que se haya activado por error
      return;
  }

  await typing(ctx, provider);
  try {
    const body = ctx.body && ctx.body.trim();

    // Comando para encender el bot
    if (body === "#ON#") {
      if (!botEnabled) {
        botEnabled = true;
        await flowDynamic([{ body: "🤖 Bot activado." }]);
      } else {
        await flowDynamic([{ body: "🤖 El bot ya está activado." }]);
      }
      return state;
    }

    // Comando para apagar el bot
    if (body === "#OFF#") {
      if (botEnabled) {
        botEnabled = false;
        await flowDynamic([{ body: "🛑 Bot desactivado. No responderé a más mensajes hasta recibir #ON#." }]);
      } else {
        await flowDynamic([{ body: "🛑 El bot ya está desactivado." }]);
      }
      return state;
    }

    // Si el bot está apagado, ignorar todo excepto #ON#
    if (!botEnabled) {
      return;
    }


    const contextId = ctx.phoneNumber || ctx.from;
    const response = await getAssistantResponse(
      ASSISTANT_ID,
      ctx.body,
      state,
      undefined,
      ctx.from,
      contextId
    );
    console.log(
      `[processUserMessage] 🤖 Respuesta del asistente para ${userId}:`,
      JSON.stringify(response, null, 2)
    );
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

// Eliminar importación de initGroupSender ya que la lógica se mueve aquí
// import { initGroupSender } from "./utils/groupSender";

// Main function to initialize the bot and load Google Sheets data
const main = async () => {
    // 1. Limpiar QR antiguo al inicio
    const qrPath = path.join(process.cwd(), 'bot.qr.png');
    if (fs.existsSync(qrPath)) {
        try {
            fs.unlinkSync(qrPath);
            console.log('🗑️ [Init] QR antiguo eliminado.');
        } catch (e) {
            console.error('⚠️ [Init] No se pudo eliminar QR antiguo:', e);
        }
    }

    // 2. Restaurar sesión de grupos desde DB
    try {
        await restoreSessionFromDb('groups');
        // Pequeña espera para asegurar que el sistema de archivos se asiente
        await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (e) {
        console.error('[Init] Error restaurando sesión de grupos:', e);
    }

    // 3. Inicializar Provider Principal (YCloud)
    setAdapterProvider(createProvider(YCloudProvider, {}));

    // 4. Inicializar Provider Secundario (Grupos - Baileys)
    try {
        console.log('📡 [GroupSync] Creando instancia de motor de grupos (Baileys)...');
        
        setGroupProvider(createProvider(BaileysProvider, {
            version: [2, 3000, 1030817285],
            groupsIgnore: false,
            readStatus: false,
            disableHttpServer: true
        }));

        // Configurar listeners redundantes para QR
        const handleQR = async (qrString: string) => {
            if (qrString) {
                console.log(`⚡ [GroupSync] QR detectado (largo: ${qrString.length}). Generando bot.groups.qr.png...`);
                const qrPath = path.join(process.cwd(), 'bot.groups.qr.png');
                await QRCode.toFile(qrPath, qrString, { scale: 10, margin: 2 });
                console.log(`✅ [GroupSync] QR guardado en ${qrPath}`);
            }
        };

        groupProvider.on('require_action', async (payload: any) => {
            console.log('⚡ [GroupSync] require_action received.');
            const qr = (typeof payload === 'string') ? payload : (payload?.qr || payload?.payload?.qr || payload?.code);
            await handleQR(qr);
        });

        groupProvider.on('qr', async (qr: string) => {
            console.log('⚡ [GroupSync] event qr received.');
            await handleQR(qr);
        });

        groupProvider.on('auth_require', async (qr: string) => {
            console.log('⚡ [GroupSync] event auth_require received.');
            await handleQR(qr);
        });

        groupProvider.on('ready', () => {
             console.log('✅ [GroupSync] Motor de grupos conectado satisfactoriamente.');
             const qrPath = path.join(process.cwd(), 'bot.groups.qr.png');
             if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
        });

        // Forzar arranque del motor secundario
        console.log('📡 [GroupSync] Iniciando vendor...');
        setTimeout(async () => {
            try {
                if (groupProvider.initVendor) {
                    await groupProvider.initVendor();
                    console.log('📡 [GroupSync] initVendor ejecutado.');
                } else if ((groupProvider as any).init) {
                    await (groupProvider as any).init();
                }
            } catch (err) {
                console.error('❌ [GroupSync] Error al llamar initVendor:', err);
            }
        }, 1000);

        groupProvider.on('message', () => {}); 

    } catch (e) {
        console.error('❌ [GroupSync] Error crítico en motor de grupos:', e);
    }

    // 5. Listeners del Provider Principal
    adapterProvider.on('require_action', async (payload: any) => {
        console.log('⚡ [Provider] require_action received. Payload:', payload);
        let qrString = null;
        if (typeof payload === 'string') {
            qrString = payload;
        } else if (payload && typeof payload === 'object') {
            if (payload.qr) qrString = payload.qr;
            else if (payload.code) qrString = payload.code;
        }
        if (qrString && typeof qrString === 'string') {
            console.log('⚡ [Provider] QR Code detected (length: ' + qrString.length + '). Generating image...');
            try {
                const qrPath = path.join(process.cwd(), 'bot.qr.png');
                await QRCode.toFile(qrPath, qrString, {
                    color: { dark: '#000000', light: '#ffffff' },
                    scale: 4,
                    margin: 2
                });
                console.log(`✅ [Provider] QR Image saved to ${qrPath}`);
            } catch (err) {
                console.error('❌ [Provider] Error generating QR image:', err);
            }
        }
    });

    adapterProvider.on('message', (ctx) => {
        console.log(`Type Msj Recibido: ${ctx.type || 'desconocido'}`);
        
        const isYCloudButton = ctx.type === 'interactive' || ctx.type === 'button';

        if (isYCloudButton) {
            console.log('🔘 Interacción de botón detectada');
            ctx.type = EVENTS.ACTION;
        }
    });

    adapterProvider.on('ready', () => {
        console.log('✅ [Provider] READY: El bot está conectado y operativo.');
    });

    errorReporter = new ErrorReporter(adapterProvider, ID_GRUPO_RESUMEN);

    console.log('🚀 [Init] Iniciando createBot...');
    const adapterFlow = createFlow([
        welcomeFlowTxt,
        welcomeFlowVoice,
        welcomeFlowImg,
        idleFlow,
    ]);
    const adapterDB = new MemoryDB();

    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    });

    // Iniciar sincronización periódica de sesión hacia Supabase (Solo para grupos)
    startSessionSync('groups');

    const app = adapterProvider.server;
    if (!app) {
        console.error('❌ [Critical] adapterProvider.server no está definido. Los webhooks y el webchat no funcionarán.');
    }

    // Middleware para parsear JSON (DEBE IR ANTES DE LAS RUTAS)
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: true }));

    // Middleware para normalizar URLs (corrige //webhook a /webhook)
    app.use((req, res, next) => {
        if (req.url.includes('//')) {
            console.log(`🧹 [Main] Normalizando URL: ${req.url}`);
            req.url = req.url.replace(/\/+/g, '/');
        }
        next();
    });

    // 1. Middleware de compatibilidad (res.json, res.send, res.sendFile, etc)
    app.use((req, res, next) => {
        // @ts-ignore
        res.status = (code) => { res.statusCode = code; return res; };
        // @ts-ignore
        res.send = (body) => {
            if (res.headersSent) return res;
            if (typeof body === 'object') {
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(body || null));
            } else {
                res.end(body || '');
            }
            return res;
        };
        // @ts-ignore
        res.json = (data) => {
            if (res.headersSent) return res;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(data || null));
            return res;
        };
        // @ts-ignore
        res.sendFile = (filepath) => {
            if (res.headersSent) return;
            try {
                if (fs.existsSync(filepath)) {
                    const ext = path.extname(filepath).toLowerCase();
                    const mimeTypes = {
                        '.html': 'text/html',
                        '.js': 'application/javascript',
                        '.css': 'text/css',
                        '.png': 'image/png',
                        '.jpg': 'image/jpeg',
                        '.gif': 'image/gif',
                        '.svg': 'image/svg+xml',
                        '.json': 'application/json'
                    };
                    res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
                    fs.createReadStream(filepath).pipe(res);
                } else {
                    res.statusCode = 404;
                    res.end('Not Found');
                }
            } catch (e) {
                res.statusCode = 500;
                res.end('Internal Error');
            }
        };
        next();
    });

    // 2. Redirect Middleware
    app.use((req, res, next) => {
        if (req.url === "/" || req.url === "") {
            res.writeHead(302, { 'Location': '/dashboard' });
            return res.end();
        }
        next();
    });

    // 3. Función para servir páginas HTML
    function serveHtmlPage(route, filename) {
        const handler = (req, res) => {
            const htmlPath = path.join(process.cwd(), 'src', 'html', filename);
            if (fs.existsSync(htmlPath)) {
                // @ts-ignore
                res.sendFile(htmlPath);
            } else {
                // @ts-ignore
                res.status(404).send('HTML no encontrado');
            }
        };
        app.get(route, handler);
    }

    // 4. Endpoint Webhook para YCloud
    app.post('/webhook', (req, res) => {
        // @ts-ignore
        adapterProvider.handleWebhook(req, res);
    });

    httpInject(adapterProvider.server);

    // Registrar páginas HTML
    serveHtmlPage("/dashboard", "dashboard.html");
    serveHtmlPage("/webchat", "webchat.html");
    serveHtmlPage("/webreset", "webreset.html");
    serveHtmlPage("/variables", "variables.html");

    // Servir archivos estáticos
    app.use("/js", serve(path.join(process.cwd(), "src", "js")));
    app.use("/style", serve(path.join(process.cwd(), "src", "style")));
    app.use("/assets", serve(path.join(process.cwd(), "src", "assets")));

    // Servir el código QR de Grupos
    app.get("/groups-qr.png", (req, res) => {
        const qrPath = path.join(process.cwd(), 'bot.groups.qr.png');
        if (fs.existsSync(qrPath)) {
            res.setHeader('Content-Type', 'image/png');
            fs.createReadStream(qrPath).pipe(res);
        } else {
            res.statusCode = 404;
            res.end('QR not found');
        }
    });

    // Endpoints de API
    app.get('/api/assistant-name', (req, res) => {
        const assistantName = process.env.ASSISTANT_NAME || 'Asistente demo';
        // @ts-ignore
        res.json({ name: assistantName });
    });

    app.get('/api/dashboard-status', async (req, res) => {
        const status = await getBotStatus();
        // @ts-ignore
        res.json(status);
    });

    app.post('/api/delete-session', async (req, res) => {
        try {
            console.log('[API] Solicitud de eliminación de sesión recibida.');
            const sessionDirs = ['bot_sessions', 'groups_sessions'];
            sessionDirs.forEach(dir => {
                const p = path.join(process.cwd(), dir);
                if (fs.existsSync(p)) {
                    console.log('[API] Eliminando directorio local:', p);
                    fs.rmSync(p, { recursive: true, force: true });
                }
            });

            ['bot.qr.png', 'bot.groups.qr.png'].forEach(file => {
                const p = path.join(process.cwd(), file);
                if (fs.existsSync(p)) fs.unlinkSync(p);
            });

            await deleteSessionFromDb('groups');
            // @ts-ignore
            res.json({ success: true, message: "Sesión eliminada correctamente" });
        } catch (err) {
            console.error('Error en /api/delete-session:', err);
            // @ts-ignore
            res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.post("/api/restart-bot", async (req, res) => {
        try {
            const result = await RailwayApi.restartActiveDeployment();
            if (result.success) {
                // @ts-ignore
                res.json({ success: true, message: "Reinicio solicitado correctamente." });
            } else {
                // @ts-ignore
                res.status(500).json({ success: false, error: result.error || "Error desconocido" });
            }
        } catch (err: any) {
            // @ts-ignore
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.get("/api/variables", async (req, res) => {
        try {
            const variables = await RailwayApi.getVariables();
            if (variables) {
                // @ts-ignore
                res.json({ success: true, variables });
            } else {
                // @ts-ignore
                res.status(500).json({ success: false, error: "No se pudieron obtener las variables de Railway" });
            }
        } catch (err: any) {
            // @ts-ignore
            res.status(500).json({ success: false, error: err.message });
        }
    });

    app.post("/api/update-variables", async (req, res) => {
        try {
            // @ts-ignore
            const { variables } = req.body;
            if (!variables || typeof variables !== 'object') {
                // @ts-ignore
                return res.status(400).json({ success: false, error: "Variables no proporcionadas" });
            }

            const updateResult = await RailwayApi.updateVariables(variables);
            if (!updateResult.success) {
                // @ts-ignore
                return res.status(500).json({ success: false, error: updateResult.error });
            }

            const restartResult = await RailwayApi.restartActiveDeployment();
            // @ts-ignore
            res.json({ success: true, message: "Variables actualizadas y reinicio solicitado." });
        } catch (err: any) {
            // @ts-ignore
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 💬 Integración de Webchat y Socket.IO
    if (app && app.server) {
        const realHttpServer = app.server;
        const io = new Server(realHttpServer, { cors: { origin: "*" } });

        io.on("connection", (socket) => {
            console.log("💬 [Webchat] Nuevo cliente conectado");
            socket.on("message", async (msg) => {
                console.log(`💬 [Webchat] Mensaje recibido: "${msg}"`);
                try {
                    let ip = "";
                    const xff = socket.handshake.headers["x-forwarded-for"];
                    if (typeof xff === "string") ip = xff.split(",")[0];
                    else ip = socket.handshake.address || "";

                    const historyKey = `webchat_${ip}`;
                    if (!global.webchatHistories) global.webchatHistories = {};
                    if (!global.webchatHistories[historyKey]) global.webchatHistories[historyKey] = [];
                    const _history = global.webchatHistories[historyKey];

                    // Objeto state simulado para webchat
                    const state = {
                        data: {},
                        get: function (key) {
                            if (key === "history") return _history;
                            if (key === "thread_id") return this.data.thread_id;
                            return this.data[key];
                        },
                        update: async function (obj) {
                            if (typeof obj === 'object') {
                                Object.assign(this.data, obj);
                            }
                        },
                        clear: async function () {
                            this.data = {};
                            _history.length = 0;
                        },
                    };

                    const flowDynamic = async (arr) => {
                        let text = "";
                        if (Array.isArray(arr)) text = arr.map((a) => a.body).join("\n");
                        else text = String(arr);
                        console.log(`💬 [Webchat] Enviando respuesta a ${ip}: "${text}"`);
                        socket.emit("reply", text);
                    };

                    console.log(`💬 [Webchat] Solicitando respuesta al asistente para ${ip}...`);
                    const response = await getAssistantResponse(ASSISTANT_ID, msg, state, undefined, ip, ip);
                    
                    await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                        response,
                        { from: ip, body: msg, type: "webchat" },
                        flowDynamic,
                        state,
                        undefined,
                        () => {},
                        getAssistantResponse,
                        ASSISTANT_ID
                    );
                } catch (err) {
                    console.error("❌ [Webchat] Error procesando mensaje:", err);
                    socket.emit("reply", "Hubo un error procesando tu mensaje.");
                }
            });
        });

        const assistantBridge = new AssistantBridge();
        assistantBridge.setupWebChat(app, realHttpServer);
    } else {
        console.warn('⚠️ [Webchat] No se pudo inicializar Socket.IO porque app.server no existe.');
    }

    app.post("/webchat-api", async (req, res) => {
        try {
            const { message } = req.body;
            let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
            if (Array.isArray(ip)) ip = ip[0];

            console.log(`[WebChat API] Mensaje de ${ip}: ${message}`);

            const session = webChatManager.getSession(ip);
            const { getOrCreateThreadId, sendMessageToThread } = await import("./utils-web/openaiThreadBridge");

            let replyTextArr = [];
            const flowDynamic = async (arr) => {
                if (Array.isArray(arr)) replyTextArr.push(...arr.map(a => a.body));
                else replyTextArr.push(arr);
            };

            const threadId = await getOrCreateThreadId(session);
            console.log(`[WebChat API] Thread ID: ${threadId}`);
            const reply = await sendMessageToThread(threadId, message, ASSISTANT_ID);
            console.log(`[WebChat API] Respuesta de OpenAI: "${reply}"`);

            await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
                reply,
                { from: ip as string, body: message, type: "webchat" },
                flowDynamic,
                session,
                undefined,
                () => {},
                async (...args) => await sendMessageToThread(threadId, args[1], ASSISTANT_ID),
                ASSISTANT_ID
            );

            // @ts-ignore
            res.json({ reply: replyTextArr.join("\n\n") });
        } catch (err) {
            console.error("Error en /webchat-api:", err);
            // @ts-ignore
            res.status(500).json({ reply: "Hubo un error procesando tu mensaje." });
        }
    });

    // Iniciar servidor
    console.log(`📡 [Main] Intentando iniciar servidor en puerto ${PORT}...`);
    try {
        httpServer(+PORT);
        console.log(`✅ [Main] Servidor escuchando en puerto ${PORT}`);
    } catch (err) {
        console.error('❌ [Main] Error fatal al iniciar httpServer:', err);
    }
};

main().catch(err => {
    console.error('❌ [Main] Error crítico en la función main:', err);
});
