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
// import { AssistantBridge } from "./utils-web/AssistantBridge";
import { WebChatManager } from "./utils-web/WebChatManager";
import { fileURLToPath } from "url";
import { AssistantResponseProcessor, waitForActiveRuns, safeToAsk } from "./utils/AssistantResponseProcessor";
import { getArgentinaDatetimeString } from "./utils/ArgentinaTime";
import { RailwayApi } from "./Api-RailWay/Railway";
import { HistoryHandler, historyEvents } from "./utils/historyHandler";

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

export let errorReporter;

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

const getAssistantResponse = async (
  assistantId,
  message,
  state,
  fallbackMessage,
  userId,
  userPhone
) => {
  const currentDatetimeArg = getArgentinaDatetimeString();
  let systemPrompt = `Fecha, hora y día de la semana de referencia: ${currentDatetimeArg}`;
  
  if (process.env.EXTRA_SYSTEM_PROMPT) {
      systemPrompt += `\nInstrucción de refuerzo: ${process.env.EXTRA_SYSTEM_PROMPT}`;
  }

  if (fallbackMessage) systemPrompt += `\n${fallbackMessage}`;
  if (userPhone) systemPrompt += `\nNúmero de contacto: ${userPhone}`;

  // safeToAsk ya tiene su propia lógica de reintentos y esperas.
  // Solo envolvemos en un timeout para que el flujo de BuilderBot no se cuelgue infinitamente,
  // pero NO disparamos una segunda petición si la primera tarda.
  
  return new Promise((resolve) => {
    let completed = false;
    const timeoutId = setTimeout(() => {
      if (!completed) {
        console.warn(`[Timeout] Respuesta de Assistant tardando más de ${TIMEOUT_MS / 1000}s para ${userId}`);
        completed = true;
        resolve(null); // Resolvemos con null para que el llamador sepa que hubo timeout
      }
    }, TIMEOUT_MS);

    (async () => {
      try {
        const result = await safeToAsk(
          assistantId,
          systemPrompt + "\n" + message,
          state,
          userId,
          errorReporter
        );
        if (!completed) {
          clearTimeout(timeoutId);
          completed = true;
          resolve(result);
        }
      } catch (error) {
        if (!completed) {
          clearTimeout(timeoutId);
          completed = true;
          console.error(`[Error] Fallo crítico en safeToAsk para ${userId}:`, error);
          resolve(null);
        }
      }
    })();
  });
};

export const processUserMessage = async (
  ctx,
  { flowDynamic, state, provider, gotoFlow }
) => {
  const userId = ctx.from;
  // console.log(`[processUserMessage] 📬 Procesando mensaje de ${userId}: "${ctx.body}"`);
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
            await HistoryHandler.toggleBot(ctx.from, true);
            if (ctx.pushName) await HistoryHandler.getOrCreateChat(ctx.from, 'whatsapp', ctx.pushName);
            const msg = "🤖 Bot activado para este chat.";
            await flowDynamic([{ body: msg }]);
            await HistoryHandler.saveMessage(ctx.from, 'assistant', msg, 'text');
            return state;
        }

        // Comando para apagar el bot
        if (body === "#OFF#") {
            await HistoryHandler.toggleBot(ctx.from, false);
            if (ctx.pushName) await HistoryHandler.getOrCreateChat(ctx.from, 'whatsapp', ctx.pushName);
            const msg = "🛑 Bot desactivado. (Intervención humana activa)";
            await flowDynamic([{ body: msg }]);
            await HistoryHandler.saveMessage(ctx.from, 'assistant', msg, 'text');
            return state;
        }

        // Persistir mensaje del usuario
        await HistoryHandler.saveMessage(
            ctx.from, 
            'user', 
            body || (ctx.type === EVENTS.VOICE_NOTE ? "[Audio]" : "[Media]"), 
            ctx.type,
            ctx.pushName || null
        );

        // Verificar si el bot está habilitado para este usuario específico
        const isBotActiveForUser = await HistoryHandler.isBotEnabled(ctx.from);
        if (!isBotActiveForUser) {
            // console.log(`[Intervención Humana] Bot ignorando mensaje de ${ctx.from}`);
            return state;
        }

        // Comando global para encender el bot
        if (body === "#GLOBAL_ON#") {
            let msg = "";
            if (!botEnabled) {
                botEnabled = true;
                msg = "🤖 Bot global activado.";
                await flowDynamic([{ body: msg }]);
            } else {
                msg = "🤖 El bot global ya está activado.";
                await flowDynamic([{ body: msg }]);
            }
            await HistoryHandler.saveMessage(ctx.from, 'assistant', msg, 'text');
            return state;
        }

        if (!botEnabled) return;


    const contextId = ctx.phoneNumber || ctx.from;
    const response = await getAssistantResponse(
      ASSISTANT_ID,
      ctx.body,
      state,
      undefined,
      ctx.from,
      contextId
    );
    console.log(`[processUserMessage] 🤖 Respuesta del asistente para ${userId}:`, JSON.stringify(response, null, 2));
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
    // console.error("Error al procesar el mensaje del usuario:", error);
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
      // console.error(`Error procesando el mensaje de ${userId}:`, error);
    }
  }

  userLocks.set(userId, false);
  userQueues.delete(userId);
};

// Eliminar importación de initGroupSender ya que la lógica se mueve aquí
// import { initGroupSender } from "./utils/groupSender";

// Main function to initialize the bot and load Google Sheets data
const main = async () => {
    // 1. Limpiar QRs antiguos al inicio para evitar mostrar estados obsoletos
    const qrsToClean = ['bot.qr.png', 'bot.groups.qr.png'];
    qrsToClean.forEach(file => {
        const p = path.join(process.cwd(), file);
        if (fs.existsSync(p)) {
            try {
                fs.unlinkSync(p);
                console.log(`[Init] Limpieza inicial: ${file} eliminado.`);
            } catch (e) {
                console.error(`[Init] Error limpiando ${file}:`, e);
            }
        }
    });

    // 2. Restaurar sesión de grupos desde DB
    try {
        await restoreSessionFromDb('groups');
        // Pequeña espera para asegurar que el sistema de archivos se asiente
        await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (e) {
        // console.error('[Init] Error restaurando sesión de grupos:', e);
    }

    // 3. Inicializar Provider Principal (YCloud)
    setAdapterProvider(createProvider(YCloudProvider, {}));

    // 4. Inicializar Provider Secundario (Grupos - Baileys)
    try {
        // console.log('📡 [GroupSync] Creando instancia de motor de grupos (Baileys)...');
        
        setGroupProvider(createProvider(BaileysProvider, {
            //version: [2, 3000, 1030817285],  //version actual, precaria
            version: [2, 3000, 1038711718], //ultima version para test
            groupsIgnore: false,
            readStatus: false,
            disableHttpServer: true
        }));

        // Configurar listeners redundantes para QR
        const handleQR = async (qrString: string) => {
            if (qrString && typeof qrString === 'string') {
                console.log(`⚡ [GroupSync] Generando bot.groups.qr.png (largo: ${qrString.length})...`);
                const qrPath = path.join(process.cwd(), 'bot.groups.qr.png');
                await QRCode.toFile(qrPath, qrString, { scale: 10, margin: 2 });
                console.log(`✅ [GroupSync] QR guardado exitosamente.`);
            } else if (qrString) {
                console.warn('⚠️ [GroupSync] Se recibió un QR que no es string:', typeof qrString);
            }
        };

        const extractQR = (payload: any) => {
            if (typeof payload === 'string') return payload;
            return payload?.qr || payload?.payload?.qr || payload?.code || payload?.payload?.code;
        }

        groupProvider.on('require_action', async (payload: any) => {
            console.log('⚡ [GroupSync] require_action received.');
            const qr = extractQR(payload);
            await handleQR(qr);
        });

        groupProvider.on('auth_require', async (payload: any) => {
            console.log('⚡ [GroupSync] auth_require received.');
            const qr = extractQR(payload);
            await handleQR(qr);
        });

        groupProvider.on('qr', async (qr: any) => {
            console.log('⚡ [GroupSync] event qr received.');
            const qrStr = extractQR(qr);
            await handleQR(qrStr);
        });

        groupProvider.on('ready', () => {
             console.log('✅ [GroupSync] Motor de grupos conectado satisfactoriamente.');
             const qrPath = path.join(process.cwd(), 'bot.groups.qr.png');
             if (fs.existsSync(qrPath)) {
                 fs.unlinkSync(qrPath);
                 console.log('🗑️ [GroupSync] QR temporal eliminado tras conexión exitosa.');
             }
        });

        groupProvider.on('auth_failure', (err) => {
            console.error('❌ [GroupSync] Error de autenticación:', err);
        });

        groupProvider.on('error', (err) => {
            console.error('❌ [GroupSync] Error en el provider de grupos:', err);
        });

        // Forzar arranque del motor secundario
        // console.log('📡 [GroupSync] Iniciando vendor...');
        setTimeout(async () => {
            try {
                if (groupProvider.initVendor) {
                    await groupProvider.initVendor();
                    // console.log('📡 [GroupSync] initVendor ejecutado.');
                } else if ((groupProvider as any).init) {
                    await (groupProvider as any).init();
                }
            } catch (err) {
                // console.error('❌ [GroupSync] Error al llamar initVendor:', err);
            }
        }, 1000);

        groupProvider.on('message', () => {}); 

    } catch (e) {
        // console.error('❌ [GroupSync] Error crítico en motor de grupos:', e);
    }

    // 5. Listeners del Provider Principal
    adapterProvider.on('require_action', async (payload: any) => {
        // console.log('⚡ [Provider] require_action received. Payload:', payload);
        let qrString = null;
        if (typeof payload === 'string') {
            qrString = payload;
        } else if (payload && typeof payload === 'object') {
            if (payload.qr) qrString = payload.qr;
            else if (payload.code) qrString = payload.code;
        }
        if (qrString && typeof qrString === 'string') {
            // console.log('⚡ [Provider] QR Code detected (length: ' + qrString.length + '). Generating image...');
            try {
                const qrPath = path.join(process.cwd(), 'bot.qr.png');
                await QRCode.toFile(qrPath, qrString, {
                    color: { dark: '#000000', light: '#ffffff' },
                    scale: 4,
                    margin: 2
                });
                // console.log(`✅ [Provider] QR Image saved to ${qrPath}`);
            } catch (err) {
                // console.error('❌ [Provider] Error generating QR image:', err);
            }
        }
    });

    adapterProvider.on('message', (ctx) => {
        // console.log(`Type Msj Recibido: ${ctx.type || 'desconocido'}`);
        
        const isYCloudButton = ctx.type === 'interactive' || ctx.type === 'button';

        if (isYCloudButton) {
            // console.log('🔘 Interacción de botón detectada');
            ctx.type = EVENTS.ACTION;
        }
    });

    adapterProvider.on('ready', () => {
        // console.log('✅ [Provider] READY: El bot está conectado y operativo.');
    });

    errorReporter = new ErrorReporter(adapterProvider, ID_GRUPO_RESUMEN);

    // console.log('🚀 [Init] Iniciando createBot...');
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
        // console.error('❌ [Critical] adapterProvider.server no está definido. Los webhooks y el webchat no funcionarán.');
    }

    // Middleware para parsear JSON (DEBE IR ANTES DE LAS RUTAS)
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: true }));

    // Middleware para normalizar URLs (corrige //webhook a /webhook)
    app.use((req, res, next) => {
        if (req.url.includes('//')) {
            // console.log(`🧹 [Main] Normalizando URL: ${req.url}`);
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

    function serveHtmlPage(route: string, filename: string) {
        const handler = (req, res) => {
            const htmlPath = path.join(process.cwd(), 'src', 'html', filename);
            if (fs.existsSync(htmlPath)) {
                const botName = process.env.ASSISTANT_NAME || process.env.RAILWAY_PROJECT_NAME || 'Asistente';
                let html = fs.readFileSync(htmlPath, 'utf8');
                
                // Reemplazos genéricos
                html = html.replace(/<title>.*?<\/title>/gi, `<title>${filename === 'dashboard.html' ? 'Dashboard' : 'Backoffice'} - ${botName}</title>`);
                
                // Reemplazos específicos
                if (filename === 'backoffice.html') {
                    // Buscar el H2 de Backoffice en el sidebar y añadirle el nombre del bot
                    html = html.replace(/<h2[^>]*>Backoffice<\/h2>/gi, `<h2 style="margin:0; font-size: 1.2rem;">Backoffice - ${botName}</h2>`);
                } else if (filename === 'dashboard.html') {
                    // Reemplazar el título principal del dashboard
                    html = html.replace(/<h1>.*?<\/h1>/gi, `<h1>🤖 Panel de Control - ${botName}</h1>`);
                }
                
                // @ts-ignore
                res.send(html);
            } else {
                // @ts-ignore
                res.status(404).send('HTML no encontrado');
            }
        };
        app.get(route, handler);
    }

    // 4. Endpoint Webhook para YCloud
    app.post('/webhook', (req, res) => {
        // Enviar 200 OK inmediatamente al proveedor (YCloud)
        res.status(200).send('OK');
        
        // Derivar el procesamiento del webhook en segundo plano
        setTimeout(() => {
            try {
                // @ts-ignore
                adapterProvider.handleWebhook(req, res);
            } catch (err) {
                console.error('⚠️ [Webhook] Error delegando el webhook a YCloudProvider:', err);
            }
        }, 10); // Un breve delay permite que Node "flushee" (envíe) la respuesta HTTP
    });

    httpInject(adapterProvider.server);

    // Registrar páginas HTML
    serveHtmlPage("/dashboard", "dashboard.html");
    serveHtmlPage("/webchat", "webchat.html");
    serveHtmlPage("/webreset", "webreset.html");
    serveHtmlPage("/variables", "variables.html");
    serveHtmlPage("/login", "login.html");
    serveHtmlPage("/backoffice", "backoffice.html");

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

    // --- ENDPOINTS BACKOFFICE ---
    const backofficeAuth = (req, res, next) => {
        const token = req.headers['authorization'] || req.query.token;
        const expectedToken = process.env.BACKOFFICE_TOKEN;
        if (token === expectedToken) {
            return next();
        }
        res.status(401).json({ success: false, error: "Unauthorized" });
    };

    app.post('/api/backoffice/auth', (req, res) => {
        const token = req.body && req.body.token;
        if (token === process.env.BACKOFFICE_TOKEN) {
            // @ts-ignore
            res.json({ success: true });
        } else {
            // @ts-ignore
            res.status(401).json({ success: false, error: "Invalid token" });
        }
    });

    app.get('/api/backoffice/chats', backofficeAuth, async (req, res) => {
        const chats = await HistoryHandler.listChats();
        // @ts-ignore
        res.json(chats);
    });

    app.get('/api/backoffice/messages/:chatId', backofficeAuth, async (req, res) => {
        const messages = await HistoryHandler.getMessages(req.params.chatId);
        // @ts-ignore
        res.json(messages);
    });

    app.get('/api/backoffice/profile-pic/:chatId', async (req, res) => {
        try {
            const { chatId } = req.params;
            const token = req.query.token as string;

            if (token !== process.env.BACKOFFICE_TOKEN) {
                res.statusCode = 401;
                return res.end();
            }

            if (!adapterProvider) {
                console.error('[ProfilePic] Error: adapterProvider no inicializado');
                res.statusCode = 500;
                return res.end();
            }

            let jid = chatId;
            if (chatId.match(/^\d+$/) && !chatId.includes('@')) {
                jid = `${chatId}@s.whatsapp.net`;
            }

            const vendor = (adapterProvider as any).vendor;
            if (vendor && typeof vendor.profilePictureUrl === 'function') {
                try {
                    const url = await vendor.profilePictureUrl(jid, 'image');
                    if (url) {
                        res.writeHead(302, { Location: url });
                        return res.end();
                    }
                } catch (picError) {
                    console.log(`[ProfilePic] No se pudo obtener foto para ${jid}:`, picError.message);
                }
            }
            
            res.statusCode = 404;
            res.end();
        } catch (e) {
            console.error('[ProfilePic] Error excepcional:', e);
            res.statusCode = 500;
            res.end();
        }
    });

    app.post('/api/backoffice/toggle-bot', backofficeAuth, async (req, res) => {
        // @ts-ignore
        const { chatId, enabled } = req.body;
        const result = await HistoryHandler.toggleBot(chatId, enabled);
        // @ts-ignore
        res.json(result);
    });

    app.post('/api/backoffice/send-message', backofficeAuth, async (req, res) => {
        // @ts-ignore
        const { chatId, content } = req.body;
        console.log(`[Backoffice] Intentando enviar mensaje a ${chatId}: "${content.substring(0, 50)}..."`);
        
        try {
            if (!adapterProvider) {
                // @ts-ignore
                return res.status(500).json({ success: false, error: "Provider not ready (adapterProvider is null)" });
            }

            let targetJid = chatId;
            if (chatId.match(/^\d+$/) && !chatId.includes('@')) {
                targetJid = `${chatId}@s.whatsapp.net`;
            }

            if (typeof adapterProvider.sendMessage === 'function') {
                await adapterProvider.sendMessage(targetJid, content, {});
            } else if (typeof adapterProvider.sendText === 'function') {
                await adapterProvider.sendText(targetJid, content);
            } else {
                // @ts-ignore
                return res.status(500).json({ success: false, error: "Provider methods not found" });
            }
            await HistoryHandler.saveMessage(chatId, 'assistant', content, 'text');
            // @ts-ignore
            return res.json({ success: true });
        } catch (err: any) {
            console.error('[Backoffice] Error excepcional enviando mensaje:', err);
            // @ts-ignore
            res.status(500).json({ success: false, error: err.message || "Unknown error during send-message" });
        }
    });
    // --- FIN ENDPOINTS BACKOFFICE ---

    // Socket.IO initialization function
    const initSocketIO = (serverInstance) => {
        try {
            if (!serverInstance) {
                console.error('❌ [Socket.IO] No se pudo obtener serverInstance. app.server es null.');
                return;
            }
            console.log('📡 [INFO] Inicializando Socket.IO en el servidor principal...');
            const io = new Server(serverInstance, { 
                allowEIO3: true, 
                cors: { origin: "*" } 
            });

            // Escuchar eventos de la base de datos (HistoryHandler) y retransmitir a Web
            historyEvents.on('new_message', (payload) => {
                console.log(`📡 [Socket] Re-emitiendo new_message: ${payload.chatId}`);
                io.emit('new_message', payload);
            });

            historyEvents.on('bot_toggled', (payload) => {
                console.log(`📡 [Socket] Re-emitiendo bot_toggled: ${payload.chatId} -> ${payload.bot_enabled}`);
                io.emit('bot_toggled', payload);
            });

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

                        let replyText = "";
                        if (msg.trim().toLowerCase() === "#reset") {
                            await state.clear();
                            replyText = "🔄 Chat reiniciado.";
                        } else {
                            if (!userQueues.has(ip)) userQueues.set(ip, []);
                            const queue = userQueues.get(ip);
                            queue.push({
                                ctx: { from: ip, body: msg, type: 'webchat' },
                                flowDynamic,
                                state,
                                provider: undefined,
                                gotoFlow: () => { /* no-op */ }
                            });
                            if (!userLocks.get(ip) && queue.length === 1) {
                                await handleQueue(ip);
                            }
                        }
                        if (replyText) socket.emit('reply', replyText);
                    } catch (err) {
                        console.error("Error Socket.IO:", err);
                        socket.emit("reply", "Error procesando mensaje.");
                    }
                });
            });
        } catch (e) {
            console.error('❌ [Socket.IO] Error durante la inicialización:', e);
        }
    };

    // 💬 Integración de Webchat y Socket.IO (Centralizado en initSocketIO)
    serveHtmlPage("/webchat", "webchat.html");

    app.post("/webchat-api", async (req, res) => {
        try {
            const { message } = req.body;
            let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
            if (Array.isArray(ip)) ip = ip[0];

            console.log(`[WebChat API] Mensaje de ${ip}: ${message}`);

            const session = webChatManager.getSession(ip);
            const { getOrCreateThreadId, sendMessageToThread } = await import("./utils-web/openaiThreadBridge");

            const replyTextArr = [];
            const flowDynamic = async (arr) => {
                if (Array.isArray(arr)) replyTextArr.push(...arr.map(a => a.body));
                else replyTextArr.push(arr);
            };

            const threadId = await getOrCreateThreadId(session);
            console.log(`[WebChat API] Thread ID: ${threadId}`);
            if (!userQueues.has(ip)) userQueues.set(ip, []);
            const queue = userQueues.get(ip);
            
            queue.push({
                ctx: { from: ip as string, body: message, type: "webchat" },
                flowDynamic,
                state: session,
                provider: undefined,
                gotoFlow: () => {}
            });

            if (!userLocks.get(ip) && queue.length === 1) {
                await handleQueue(ip);
            } else {
                while (userLocks.get(ip)) {
                    await new Promise(res => setTimeout(res, 500));
                }
            }

            // @ts-ignore
            res.json({ reply: replyTextArr.join("\n\n") });
        } catch (err) {
            console.error("Error en /webchat-api:", err);
            // @ts-ignore
            res.status(500).json({ reply: "Hubo un error procesando tu mensaje." });
        }
    });

    // Iniciar servidor
    try {
        console.log(`🚀 [INFO] Iniciando servidor en puerto ${PORT}...`);
        httpServer(+PORT);
        console.log(`✅ [INFO] Servidor escuchando en puerto ${PORT}`);
        
        // Esperamos un segundo para asegurar que el servidor subyacente esté listo
        setTimeout(() => {
            if (app && app.server) {
                console.log('✅ [INFO] app.server detectado, lanzando initSocketIO');
                initSocketIO(app.server);
            } else {
                console.error('❌ [ERROR] app.server NO DETECTADO después del listen.');
            }
        }, 1000);
        
    } catch (err) {
        console.error('❌ [ERROR] Error al iniciar servidor:', err);
    }
};

main().catch(err => {
    console.error('❌ [Main] Error crítico en la función main:', err);
});
