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
import { deleteSessionFromDb } from "./utils/sessionSync";
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

// Función auxiliar para verificar si existe sesión activa (Local o Remota)
// Función auxiliar para verifica estado (API)
const hasActiveSession = async () => {
  // Con YCloud (API), la sesión se considera "siempre activa" si hay API Key.
  return { active: true, source: 'ycloud-api' };
};

const adapterProvider = createProvider(YCloudProvider, {});

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

import { initGroupSender } from "./utils/groupSender";

// Main function to initialize the bot and load Google Sheets data
const main = async () => {
  // Inicializar Provider Secundario para Grupos (Baileys)
  // Esto levantará su lógica de QR y sesión independientemente del bot principal
  await initGroupSender();

  // Restaurar sesión principal (YCloud no la usa, pero dejamos comentado por referencia)
  // await restoreSessionFromDb();

  // Limpiar QR antiguo al inicio (opcional, limpieza)
  const qrPath = path.join(process.cwd(), 'bot.qr.png');
  if (fs.existsSync(qrPath)) {
    try {
      fs.unlinkSync(qrPath);
    } catch (e) { }
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
  const adapterProvider = createProvider(YCloudProvider, {});

  /* QR Listener eliminado para YCloud */

  const adapterDB = new MemoryDB();
  const { httpServer } = await createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB,
  });

  // Iniciar sincronización periódica de sesión hacia Supabase
  // Sincronización DB: NO NECESARIO EN YCLOUD
  // startSessionSync();

  const app = adapterProvider.server;

  // Middleware de logging detallado y normalización de URL
  app.use((req, res, next) => {
    // Normalizar URL: cambiar // por / (común cuando hay errores de configuración en el dashboard del proveedor)
    if (req.url.startsWith('//')) {
      req.url = req.url.replace(/^\/+/, '/');
    }

    if (req.method === 'POST') {
      console.log(`[POST-DEBUG] ${req.url} - Headers: ${JSON.stringify(req.headers['content-type'])}`);
    }
    next();
  });

  // Middleware para parsear JSON
  app.use(bodyParser.json());

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
          fs.createReadStream(filepath)
            .on('error', (err) => {
              console.error(`[ERROR] Stream error in sendFile (${filepath}):`, err);
              if (!res.headersSent) {
                res.statusCode = 500;
                res.end('Internal Server Error');
              }
            })
            .pipe(res);
        } else {
          console.error(`[ERROR] sendFile: File not found: ${filepath}`);
          res.statusCode = 404;
          res.end('Not Found');
        }
      } catch (e) {
        console.error(`[ERROR] Error in sendFile (${filepath}):`, e);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('Internal Error');
        }
      }
    };
    next();
  });

  // 2. Redirect Middleware
  app.use((req, res, next) => {
    try {
      if (req.url === "/" || req.url === "") {
        console.log('[DEBUG] Redirigiendo raíz (/) a /dashboard via middleware');
        res.writeHead(302, { 'Location': '/dashboard' });
        return res.end();
      }
      next();
    } catch (err) {
      console.error('❌ [ERROR] Crash en cadena de middleware:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Internal Server Error');
      }
    }
  });

  // 3. Función para servir páginas HTML
  function serveHtmlPage(route, filename) {
    const handler = (req, res) => {
      console.log(`[DEBUG] Serving HTML for ${req.url} -> ${filename}`);
      try {
        const possiblePaths = [
          path.join(process.cwd(), 'src', 'html', filename),
          path.join(process.cwd(), filename),
          path.join(process.cwd(), 'src', filename),
          path.join(__dirname, 'html', filename),
          path.join(__dirname, filename),
          path.join(__dirname, '..', 'src', 'html', filename)
        ];

        let htmlPath = null;
        for (const p of possiblePaths) {
          if (fs.existsSync(p) && fs.lstatSync(p).isFile()) {
            htmlPath = p;
            break;
          }
        }

        if (htmlPath) {
          // @ts-ignore
          res.sendFile(htmlPath);
        } else {
          console.error(`[ERROR] File not found: ${filename}`);
          // @ts-ignore
          res.status(404).send('HTML no encontrado en el servidor');
        }
      } catch (err) {
        console.error(`[ERROR] Failed to serve ${filename}:`, err);
        // @ts-ignore
        res.status(500).send('Error interno al servir HTML');
      }
    };
    app.get(route, handler);
    if (route !== "/") {
      app.get(route + '/', handler);
    }
  }

  // Endpoint Webhook para YCloud (Múltiples variantes para asegurar match en Polka)
  const webhookHandler = (req, res) => {
    console.log('[DEBUG] Petición recibida en /webhook');
    // @ts-ignore
    adapterProvider.handleWebhook(req, res);
  };

  app.post('/webhook', webhookHandler);
  app.post('//webhook', webhookHandler);
  app.all('/webhook', webhookHandler);
  app.all('//webhook', webhookHandler);

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

  // Servir el código QR principal
  app.get("/qr.png", (req, res) => {
    const qrPath = path.join(process.cwd(), 'bot.qr.png');
    if (fs.existsSync(qrPath)) {
      res.setHeader('Content-Type', 'image/png');
      fs.createReadStream(qrPath).pipe(res);
    } else {
      res.statusCode = 404;
      res.end('QR not found');
    }
  });

  // Servir el código QR de Grupos
  app.get("/groups-qr.png", (req, res) => {
    const qrPath = path.join(process.cwd(), 'bot.groups.qr.png');
    if (fs.existsSync(qrPath)) {
      res.setHeader('Content-Type', 'image/png');
      fs.createReadStream(qrPath).pipe(res);
    } else {
      res.statusCode = 404;
      res.end('Groups QR not found');
    }
  });

  // Endpoint Webhook movido arriba
  app.get('/api/assistant-name', (req, res) => {
    const assistantName = process.env.ASSISTANT_NAME || 'Asistente demo';
    // @ts-ignore
    res.json({ name: assistantName });
  });

  app.get('/api/dashboard-status', async (req, res) => {
    const status = await hasActiveSession();
    // @ts-ignore
    res.json(status);
  });

  app.post('/api/delete-session', async (req, res) => {
    try {
      console.log('[API] Solicitud de eliminación de sesión recibida.');
      const sessionsDir = path.join(process.cwd(), 'bot_sessions');
      
      // 1. Eliminar sesión local del GroupSender
      if (fs.existsSync(sessionsDir)) {
        console.log('[API] Eliminando directorio local:', sessionsDir);
        fs.rmSync(sessionsDir, { recursive: true, force: true });
      }

      // 1.1 Eliminar QRs antiguos
      ['bot.qr.png', 'bot.groups.qr.png'].forEach(file => {
        const p = path.join(process.cwd(), file);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      });

      // 2. Eliminar sesión remota de Grupos (usamos el ID 'groups')
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
    console.log('POST /api/restart-bot recibido');
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
      console.error('Error en /api/restart-bot:', err);
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
      console.error('Error en GET /api/variables:', err);
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
        return res.status(400).json({ success: false, error: "Variables no proporcionadas o formato inválido" });
      }

      console.log("[API] Actualizando variables en Railway...");
      const updateResult = await RailwayApi.updateVariables(variables);

      if (!updateResult.success) {
        // @ts-ignore
        return res.status(500).json({ success: false, error: updateResult.error });
      }

      console.log("[API] Variables actualizadas. Solicitando reinicio...");
      const restartResult = await RailwayApi.restartActiveDeployment();

      if (restartResult.success) {
        // @ts-ignore
        res.json({ success: true, message: "Variables actualizadas y reinicio solicitado." });
      } else {
        // @ts-ignore
        res.json({ success: true, message: "Variables actualizadas, pero falló el reinicio automático.", warning: restartResult.error });
      }
    } catch (err: any) {
      console.error('Error en POST /api/update-variables:', err);
      // @ts-ignore
      res.status(500).json({ success: false, error: err.message });
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
        const gotoFlow = () => { };
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
  assistantBridge.setupWebChat(app, realHttpServer);

  app.post("/webchat-api", async (req, res) => {
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
            () => { },
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
          const gotoFlow = () => { };
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

  // Log de Webhook URL para YCloud
  if (process.env.PROJECT_URL) {
    console.log(`\n✅ YCloud Webhook URL (Configurar en Panel): ${process.env.PROJECT_URL}/webhook\n`);
  } else {
    console.log(`\n⚠️ Define PROJECT_URL en .env para ver la URL completa del Webhook.\n`);
  }
};

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

main();
