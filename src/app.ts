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
import { BaileysProvider } from "builderbot-provider-sherpa";
import { restoreSessionFromDb, startSessionSync, deleteSessionFromDb } from "./utils/sessionSync";
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

export const userQueues = new Map();
export const userLocks = new Map();

// Función auxiliar para verificar si existe sesión activa
const hasActiveSession = () => {
    try {
        const sessionsDir = path.join(process.cwd(), 'bot_sessions');
        if (!fs.existsSync(sessionsDir)) return false;
        const files = fs.readdirSync(sessionsDir);
        return files.length > 0;
    } catch (error) {
        console.error('Error verificando sesión:', error);
        return false;
    }
};

const adapterProvider = createProvider(BaileysProvider, {
  groupsIgnore: false,
  readStatus: false,
});

const errorReporter = new ErrorReporter(adapterProvider, ID_GRUPO_RESUMEN); // Reemplaza YOUR_GROUP_ID con el ID del grupo de WhatsApp

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
  systemPrompt += `Fecha y hora actual de referencia para el asistente: ${currentDatetimeArg}`;
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
  await typing(ctx, provider);
  try {
    const response = await getAssistantResponse(
      ASSISTANT_ID,
      ctx.body,
      state,
      undefined,
      ctx.from,
      ctx.from
    );
    console.log(
      "[DEBUG] Respuesta completa del asistente:",
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

// Main function to initialize the bot and load Google Sheets data
const main = async () => {
  // Restaurar sesión de WhatsApp desde Supabase si existe (ANTES de crear el provider)
  await restoreSessionFromDb();

  // Limpiar QR antiguo al inicio
  const qrPath = path.join(process.cwd(), 'bot.qr.png');
  if (fs.existsSync(qrPath)) {
      try {
          fs.unlinkSync(qrPath);
          console.log('🗑️ [Init] QR antiguo eliminado.');
      } catch (e) {
          console.error('⚠️ [Init] No se pudo eliminar QR antiguo:', e);
      }
  }

  // ...existing code...
  // const flows = [welcomeFlowTxt, welcomeFlowVoice, welcomeFlowImg];
  // if (process.env.resumenOn === "on") {
  //     flows.push(idleFlow);
  // }
  // const adapterFlow = createFlow(flows);
  const adapterFlow = createFlow([
    welcomeFlowTxt,
    welcomeFlowVoice,
    welcomeFlowImg,
    idleFlow,
  ]);
  const adapterProvider = createProvider(BaileysProvider, {
    version: [2, 3000, 1030817285],
    groupsIgnore: false,
    readStatus: false,
  });

  // Listener para generar el archivo QR manualmente cuando se solicite
  adapterProvider.on('require_action', async (payload: any) => {
      console.log('⚡ [Provider] require_action received. Payload:', payload);
      
      // Intentar extraer el string del QR de varias formas posibles
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
                  color: {
                      dark: '#000000',
                      light: '#ffffff'
                  },
                  scale: 4,
                  margin: 2
              });
              console.log(`✅ [Provider] QR Image saved to ${qrPath}`);
          } catch (err) {
              console.error('❌ [Provider] Error generating QR image:', err);
          }
      } else {
          console.log('⚠️ [Provider] require_action received but could not extract QR string.');
      }
  });

  const adapterDB = new MemoryDB();
  const { httpServer } = await createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB,
  });
  
  // Iniciar sincronización periódica de sesión hacia Supabase
  startSessionSync();

  const app = adapterProvider.server;

  // Middleware de logging
  app.use((req, res, next) => {
      console.log(`[REQUEST] ${req.method} ${req.url}`);
      next();
  });

  // Middleware para parsear JSON
  app.use(bodyParser.json());

  // Servir archivos estáticos
  app.use("/js", serve("src/js"));
  app.use("/style", serve("src/style"));
  app.use("/assets", serve("src/assets"));

  // Endpoint para servir la imagen del QR
  app.get('/qr.png', (req, res) => {
      const qrPath = path.join(process.cwd(), 'bot.qr.png');
      // Desactivar caché para asegurar que siempre se vea el QR nuevo
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      if (fs.existsSync(qrPath)) {
          res.setHeader('Content-Type', 'image/png');
          fs.createReadStream(qrPath).pipe(res);
      } else {
          // Si no hay QR, devolver 404 pero loguearlo
          console.log('[DEBUG] Solicitud de QR fallida: Archivo no encontrado en', qrPath);
          res.status(404).send('QR no encontrado');
      }
  });

  // Dashboard principal con estado y opciones de control
  app.get('/', (req, res) => {
      console.log('[DEBUG] Handling root request');
      try {
          const sessionExists = hasActiveSession();
          res.statusCode = 200;
          res.end(`
              <html>
                  <head>
                      <title>Bot Dashboard</title>
                      <meta name="viewport" content="width=device-width, initial-scale=1">
                      <style>
                          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto; background: #f0f2f5; color: #333; }
                          .card { background: white; padding: 25px; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); margin-bottom: 20px; }
                          h1 { margin-top: 0; color: #1a1a1a; font-size: 24px; }
                          h2 { font-size: 18px; color: #444; margin-bottom: 10px; }
                          .btn { display: inline-block; padding: 12px 24px; background: #008069; color: white; text-decoration: none; border-radius: 6px; border: none; cursor: pointer; font-weight: 600; transition: background 0.2s; }
                          .btn:hover { background: #006d59; }
                          .btn-danger { background: #dc3545; }
                          .btn-danger:hover { background: #c82333; }
                          .status { font-weight: bold; color: ${sessionExists ? '#008069' : '#d9534f'}; }
                          .qr-container { text-align: center; margin: 20px 0; }
                          img.qr { max-width: 280px; border: 1px solid #eee; border-radius: 8px; }
                          .info-text { color: #666; font-size: 14px; line-height: 1.5; }
                      </style>
                      ${!sessionExists ? '<meta http-equiv="refresh" content="5">' : ''}
                  </head>
                  <body>
                      <div class="card">
                          <h1>🤖 Estado del Bot</h1>
                          <p>Estado de Sesión: <span class="status">${sessionExists ? '✅ Activa (Archivos encontrados)' : '⏳ Esperando Escaneo'}</span></p>
                          
                          ${!sessionExists ? `
                              <div class="qr-container">
                                  <h3>Escanea el código QR con WhatsApp</h3>
                                  <img src="/qr.png" class="qr" alt="Cargando QR..." onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
                                  <p style="display:none; color:orange;">Generando QR... por favor espera.</p>
                                  <p class="info-text">La página se actualizará automáticamente cuando aparezca el QR.</p>
                              </div>
                          ` : `
                              <p class="info-text">El bot ha detectado archivos de sesión. Si WhatsApp no responde, usa la opción de reinicio abajo.</p>
                          `}
                      </div>

                      <div class="card">
                          <h2>💬 WebChat</h2>
                          <p class="info-text">Accede a la interfaz de chat web para pruebas o soporte.</p>
                          <a href="/webchat" class="btn">Abrir WebChat</a>
                      </div>

                      <div class="card" style="border-left: 5px solid #dc3545;">
                          <h2>⚠️ Zona de Peligro</h2>
                          <p class="info-text">Si el bot no responde en WhatsApp, elimina la sesión para generar un nuevo QR.</p>
                          <form action="/api/reset-session" method="POST" onsubmit="return confirm('¿Estás seguro? Esto desconectará WhatsApp, borrará la sesión actual y reiniciará el bot.');">
                              <button type="submit" class="btn btn-danger">🗑️ Borrar Sesión y Reiniciar</button>
                          </form>
                      </div>
                  </body>
              </html>
          `);
      } catch (e) {
          console.error('[ERROR] Root handler failed:', e);
          res.statusCode = 500;
          res.end('Internal Server Error');
      }
  });

  // Endpoint para borrar sesión y reiniciar
  app.post('/api/reset-session', async (req, res) => {
      try {
          const sessionsDir = path.join(process.cwd(), 'bot_sessions');
          console.log('[RESET] Solicitud de eliminación de sesión recibida.');
          
          // 1. Eliminar sesión local
          if (fs.existsSync(sessionsDir)) {
              console.log('[RESET] Eliminando directorio local:', sessionsDir);
              fs.rmSync(sessionsDir, { recursive: true, force: true });
          } else {
              console.log('[RESET] El directorio local no existía.');
          }

          // 1.1 Eliminar QR antiguo
          const qrPath = path.join(process.cwd(), 'bot.qr.png');
          if (fs.existsSync(qrPath)) {
              fs.unlinkSync(qrPath);
              console.log('[RESET] QR antiguo eliminado.');
          }

          // 2. Eliminar sesión remota (Supabase)
          await deleteSessionFromDb();

          // Respuesta adaptativa (JSON para fetch, HTML para form)
          if (req.headers['content-type'] === 'application/json') {
              res.end(JSON.stringify({ success: true, message: "Sesión eliminada. Reiniciando..." }));
          } else {
              res.end(`
                  <html>
                      <body style="font-family: sans-serif; text-align: center; padding: 50px;">
                          <h1 style="color: green;">✅ Sesión Eliminada (Local y Remota)</h1>
                          <p>El bot se está reiniciando. Por favor espera unos 60 segundos y recarga la página principal para escanear el nuevo QR.</p>
                          <script>
                              setTimeout(() => { window.location.href = "/"; }, 45000);
                          </script>
                      </body>
                  </html>
              `);
          }
          
          // Forzar salida del proceso para que Railway/Docker lo reinicie
          console.log('[RESET] Saliendo del proceso para reiniciar...');
          setTimeout(() => {
              process.exit(0);
          }, 1000);

      } catch (e) {
          console.error('[RESET] Error:', e);
          res.statusCode = 500;
          res.end('Error al reiniciar sesión');
      }
  });

  httpInject(adapterProvider.server);

  // Usar la instancia Polka (adapterProvider.server) para rutas

  // Servir archivos estáticos para js y style
  const polkaApp = adapterProvider.server;
  polkaApp.use("/js", serve("src/js"));
  polkaApp.use("/style", serve("src/style"));
  polkaApp.use("/assets", serve("src/assets"));
 
  // Utilidad para servir páginas HTML estáticas
  function serveHtmlPage(route, filename) {
    polkaApp.get(route, (req, res) => {
      res.setHeader("Content-Type", "text/html");
      // Buscar primero en src/ (local), luego en /app/src/ (deploy)
      let htmlPath = path.join(__dirname, filename);
      if (!fs.existsSync(htmlPath)) {
        // Buscar en /app/src/ (deploy)
        htmlPath = path.join(process.cwd(), "src", filename);
      }
      try {
        res.end(fs.readFileSync(htmlPath));
      } catch (err) {
        res.statusCode = 404;
        res.end("HTML no encontrado");
      }
    });
  }

  // Registrar páginas HTML
  serveHtmlPage("/webchat", "webchat.html");
  serveHtmlPage("/webreset", "webreset.html");
  // Endpoint para reiniciar el bot vía Railway
  polkaApp.post("/api/restart-bot", async (req, res) => {
    console.log("POST /api/restart-bot recibido");
    try {
      const result = await RailwayApi.restartActiveDeployment();
      console.log("Resultado de restartRailwayDeployment:", result);
      if (result.success) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            message: "Reinicio solicitado correctamente.",
          })
        );
      } else {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            success: false,
            error: result.error || "Error desconocido",
          })
        );
      }
    } catch (err: any) {
      console.error("Error en /api/restart-bot:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
  });
  // Integrar Socket.IO para webchat
  // Obtener el servidor HTTP real de BuilderBot después de httpInject
  const realHttpServer = adapterProvider.server.server;

  // Integrar Socket.IO sobre el servidor HTTP real de BuilderBot
  const io = new Server(realHttpServer, { cors: { origin: "*" } });
  io.on("connection", (socket) => {
    console.log("💬 Cliente web conectado");
    socket.on("message", async (msg) => {
      try {
        let ip = "";
        const xff = socket.handshake.headers["x-forwarded-for"];
        if (typeof xff === "string") {
          ip = xff.split(",")[0];
        } else if (Array.isArray(xff)) {
          ip = xff[0];
        } else {
          ip = socket.handshake.address || "";
        }
        if (!global.webchatHistories) global.webchatHistories = {};
        const historyKey = `webchat_${ip}`;
        if (!global.webchatHistories[historyKey])
          global.webchatHistories[historyKey] = [];
        const _history = global.webchatHistories[historyKey];
        const state = {
          get: function (key) {
            if (key === "history") return _history;
            return undefined;
          },
          update: async function (msg, role = "user") {
            if (_history.length > 0) {
              const last = _history[_history.length - 1];
              if (last.role === role && last.content === msg) return;
            }
            _history.push({ role, content: msg });
            if (_history.length >= 6) {
              const last3 = _history.slice(-3);
              if (last3.every((h) => h.role === "user" && h.content === msg)) {
                _history.length = 0;
              }
            }
          },
          clear: async function () {
            _history.length = 0;
          },
        };
        const provider = undefined;
        const gotoFlow = () => {};
        let replyText = "";
        const flowDynamic = async (arr) => {
          if (Array.isArray(arr)) {
            replyText = arr.map((a) => a.body).join("\n");
          } else if (typeof arr === "string") {
            replyText = arr;
          }
        };
        if (
          msg.trim().toLowerCase() === "#reset" ||
          msg.trim().toLowerCase() === "#cerrar"
        ) {
          await state.clear();
          replyText =
            "🔄 El chat ha sido reiniciado. Puedes comenzar una nueva conversación.";
        } else {
          // Obtener respuesta del asistente
          const response = await getAssistantResponse(
            ASSISTANT_ID,
            msg,
            state,
            undefined,
            ip,
            ip
          );
          // Procesar y limpiar la respuesta igual que WhatsApp
          await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
            response,
            { from: ip, body: msg, type: "webchat" },
            flowDynamic,
            state,
            provider,
            gotoFlow,
            getAssistantResponse,
            ASSISTANT_ID
          );
        }
        socket.emit("reply", replyText);
      } catch (err) {
        console.error("Error procesando mensaje webchat:", err);
        socket.emit("reply", "Hubo un error procesando tu mensaje.");
      }
    });
  });

  // Integrar AssistantBridge si es necesario
  const assistantBridge = new AssistantBridge();
  assistantBridge.setupWebChat(polkaApp, realHttpServer);

  polkaApp.post("/webchat-api", async (req, res) => {
    console.log("Llamada a /webchat-api"); // log para debug
    // Si el body ya está disponible (por ejemplo, con body-parser), úsalo directamente
    if (req.body && req.body.message) {
      console.log("Body recibido por body-parser:", req.body); // debug
      try {
        const message = req.body.message;
        console.log("Mensaje recibido en webchat:", message); // debug
        let ip = "";
        const xff = req.headers["x-forwarded-for"];
        if (typeof xff === "string") {
          ip = xff.split(",")[0];
        } else if (Array.isArray(xff)) {
          ip = xff[0];
        } else {
          ip = req.socket.remoteAddress || "";
        }
        // Crear un ctx similar al de WhatsApp, usando el IP como 'from'
        const ctx = {
          from: ip,
          body: message,
          type: "webchat",
          // Puedes agregar más propiedades si tu lógica lo requiere
        };
        // Usar la lógica principal del bot (processUserMessage)
        let replyText = "";
        // Simular flowDynamic para capturar la respuesta
        const flowDynamic = async (arr) => {
          if (Array.isArray(arr)) {
            replyText = arr.map((a) => a.body).join("\n");
          } else if (typeof arr === "string") {
            replyText = arr;
          }
        };
        // Usar WebChatManager y WebChatSession para gestionar la sesión webchat
        const { getOrCreateThreadId, sendMessageToThread, deleteThread } =
          await import("./utils-web/openaiThreadBridge");
        const session = webChatManager.getSession(ip);
        if (
          message.trim().toLowerCase() === "#reset" ||
          message.trim().toLowerCase() === "#cerrar"
        ) {
          await deleteThread(session);
          session.clear();
          replyText =
            "🔄 El chat ha sido reiniciado. Puedes comenzar una nueva conversación.";
        } else {
          session.addUserMessage(message);
          const threadId = await getOrCreateThreadId(session);
          const reply = await sendMessageToThread(
            threadId,
            message,
            ASSISTANT_ID
          );
          session.addAssistantMessage(reply);
          // Procesar la respuesta con analizarYProcesarRespuestaAsistente antes de enviarla
          let processedReply = "";
          let apiCalled = false;
          const flowDynamic = async (arr) => {
            if (Array.isArray(arr)) {
              processedReply += arr.map((a) => a.body).join("\n\n");
            } else if (typeof arr === "string") {
              processedReply += arr + "\n\n";
            }
          };
          await AssistantResponseProcessor.analizarYProcesarRespuestaAsistente(
            reply,
            ctx,
            flowDynamic,
            session,
            undefined,
            () => {},
            async (...args) => {
              apiCalled = true;
              return await sendMessageToThread(threadId, args[1], ASSISTANT_ID);
            },
            ASSISTANT_ID
          );
          replyText = processedReply;
          // Si se llamó a la API, processedReply ya contiene la respuesta procesada
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ reply: replyText }));
      } catch (err) {
        console.error("Error en /webchat-api:", err); // debug
        res.statusCode = 500;
        res.end(
          JSON.stringify({ reply: "Hubo un error procesando tu mensaje." })
        );
      }
    } else {
      // Fallback manual si req.body no está disponible
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", async () => {
        console.log("Body recibido en /webchat-api:", body); // log para debug
        try {
          const { message } = JSON.parse(body);
          console.log("Mensaje recibido en webchat:", message); // debug
          let ip = "";
          const xff = req.headers["x-forwarded-for"];
          if (typeof xff === "string") {
            ip = xff.split(",")[0];
          } else if (Array.isArray(xff)) {
            ip = xff[0];
          } else {
            ip = req.socket.remoteAddress || "";
          }
          // Centralizar historial y estado igual que WhatsApp
          if (!global.webchatHistories) global.webchatHistories = {};
          const historyKey = `webchat_${ip}`;
          if (!global.webchatHistories[historyKey])
            global.webchatHistories[historyKey] = {
              history: [],
              thread_id: null,
            };
          const _store = global.webchatHistories[historyKey];
          const _history = _store.history;
          const state = {
            get: function (key) {
              if (key === "history") return _history;
              if (key === "thread_id") return _store.thread_id;
              return undefined;
            },
            setThreadId: function (id) {
              _store.thread_id = id;
            },
            update: async function (msg, role = "user") {
              if (_history.length > 0) {
                const last = _history[_history.length - 1];
                if (last.role === role && last.content === msg) return;
              }
              _history.push({ role, content: msg });
              if (_history.length >= 6) {
                const last3 = _history.slice(-3);
                if (
                  last3.every((h) => h.role === "user" && h.content === msg)
                ) {
                  _history.length = 0;
                  _store.thread_id = null;
                }
              }
            },
            clear: async function () {
              _history.length = 0;
              _store.thread_id = null;
            },
          };
          const provider = undefined;
          const gotoFlow = () => {};
          let replyText = "";
          const flowDynamic = async (arr) => {
            if (Array.isArray(arr)) {
              replyText = arr.map((a) => a.body).join("\n");
            } else if (typeof arr === "string") {
              replyText = arr;
            }
          };
          if (
            message.trim().toLowerCase() === "#reset" ||
            message.trim().toLowerCase() === "#cerrar"
          ) {
            await state.clear();
            replyText =
              "🔄 El chat ha sido reiniciado. Puedes comenzar una nueva conversación.";
          } else {
            // ...thread_id gestionado por openaiThreadBridge, no es necesario actualizar aquí...
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ reply: replyText }));
        } catch (err) {
          console.error("Error en /webchat-api:", err); // debug
          res.statusCode = 500;
          res.end(
            JSON.stringify({ reply: "Hubo un error procesando tu mensaje." })
          );
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

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

main();
