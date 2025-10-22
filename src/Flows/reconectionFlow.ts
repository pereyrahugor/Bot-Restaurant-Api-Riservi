// Clase para manejar la lógica de reconexión cuando el campo nombre está vacío
import { toAsk } from '@builderbot-plugins/openai-assistants';
import { extraerDatosResumen, GenericResumenData } from '~/utils/extractJsonData';

// Opciones para configurar el flujo de reconexión
interface ReconectionOptions {
    ctx: any; // Contexto del usuario
    state: any; // Estado de la conversación
    provider: any; // Proveedor de mensajería
    maxAttempts?: number; // Máximo de intentos de reconexión
    timeoutMs?: number; // Tiempo de espera entre intentos (ms)
    onSuccess: (data: GenericResumenData) => Promise<void>; // Callback si se obtiene el nombre
    onFail: () => Promise<void>; // Callback si se alcanzan los intentos máximos
}

// Clase principal para el ciclo de reconexión
export class ReconectionFlow {
    private attempts = 0; // Contador de intentos realizados
    private readonly maxAttempts: number; // Máximo de intentos permitidos
    private readonly timeoutMs: number; // Tiempo de espera entre intentos
    private readonly ctx: any; // Contexto del usuario
    private readonly state: any; // Estado de la conversación
    private readonly provider: any; // Proveedor de mensajería
    private readonly onSuccess: (data: GenericResumenData) => Promise<void>; // Acción al obtener nombre
    private readonly onFail: () => Promise<void>; // Acción al fallar todos los intentos
    private readonly ASSISTANT_ID = process.env.ASSISTANT_ID ?? '';
    private readonly msjSeguimiento1: string;
    private readonly msjSeguimiento2: string;
    private readonly msjSeguimiento3: string;

    constructor(options: ReconectionOptions) {
        this.ctx = options.ctx;
        this.state = options.state;
        this.provider = options.provider;
        this.maxAttempts = options.maxAttempts ?? 3;
        this.timeoutMs = options.timeoutMs ?? 60000;
        this.onSuccess = options.onSuccess;
        this.onFail = options.onFail;

        // Validar que las variables de entorno requeridas existen y no son vacías
        const msj1 = process.env.msjSeguimiento1;
        const msj2 = process.env.msjSeguimiento2;
        const msj3 = process.env.msjSeguimiento3;
        if (!msj1 || !msj2 || !msj3) {
            throw new Error('[ReconectionFlow] Faltan variables de entorno obligatorias: msjSeguimiento1, msjSeguimiento2 o msjSeguimiento3. Verifica tu configuración.');
        }
        this.msjSeguimiento1 = msj1;
        this.msjSeguimiento2 = msj2;
        this.msjSeguimiento3 = msj3;
    }

    // Inicia el ciclo de reconexión
    async start() {
        // Intentar restaurar el estado previo si existe
        if (this.state && this.state.reconectionFlow) {
            this.restoreState(this.state.reconectionFlow);
            console.log('[ReconectionFlow] Estado restaurado:', this.state.reconectionFlow);
        }
        const originalCtx = { ...this.ctx };
        const originalFrom = originalCtx.from;
        const jid = originalFrom && originalFrom.endsWith('@s.whatsapp.net')
            ? originalFrom
            : `${originalFrom}@s.whatsapp.net`;
        console.log(`[ReconectionFlow] originalCtx.from:`, originalFrom, '| jid usado:', jid);
        while (this.attempts < this.maxAttempts) {
            this.attempts++;
            // Guardar el estado actual de reconexión en el state global
            if (this.state) {
                this.state.reconectionFlow = this.getState();
            }
            let msg: string;
            let timeout: number;
            switch (this.attempts) {
                case 1: {
                    msg = this.msjSeguimiento1;
                    const t2 = process.env.timeOutSeguimiento2;
                    if (!t2 || isNaN(Number(t2))) {
                        throw new Error('[ReconectionFlow] Falta o es inválida la variable de entorno timeOutSeguimiento2.');
                    }
                    timeout = Number(t2) * 60 * 1000;
                    break;
                }
                case 2: {
                    msg = this.msjSeguimiento2;
                    const t3 = process.env.timeOutSeguimiento3;
                    if (!t3 || isNaN(Number(t3))) {
                        throw new Error('[ReconectionFlow] Falta o es inválida la variable de entorno timeOutSeguimiento3.');
                    }
                    timeout = Number(t3) * 60 * 1000;
                    break;
                }
                case 3:
                default:
                    msg = this.msjSeguimiento3;
                    timeout = 60000; // 1 minuto para el siguiente msj
                    break;
            }
            if (typeof timeout !== 'number' || isNaN(timeout)) timeout = this.timeoutMs;
            if (!msg || typeof msg !== 'string' || msg.trim() === '') {
                throw new Error(`[ReconectionFlow] El mensaje de seguimiento para el intento ${this.attempts} es vacío o inválido. Verifica tus variables de entorno.`);
            }
            if (jid) {
                try {
                    console.log(`[ReconectionFlow] Enviando mensaje de reconexión a:`, jid);
                    await this.provider.sendText(jid, msg);
                } catch (err) {
                    console.error(`[ReconectionFlow] Error enviando mensaje de reconexión a ${jid}:`, err);
                }
            } else {
                console.warn('[ReconectionFlow] Contexto inválido, no se puede enviar mensaje de reconexión.');
            }
            console.log(`[ReconectionFlow] Intento ${this.attempts} de ${this.maxAttempts} para ${jid} | Timeout: ${timeout}ms`);

            // Espera el timeout o la respuesta del usuario, lo que ocurra primero
            const userResponded = await this.waitForUserResponse(jid, timeout);
            if (userResponded) {
                // Limpiar el estado de reconexión y delegar la navegación al callback onSuccess
                if (this.state) delete this.state.reconectionFlow;
                // Llama al callback onSuccess, que debe encargarse de la navegación
                await this.onSuccess({});
                return;
            }

            // Si no respondió, intentar obtener el resumen nuevamente desde el asistente
            const resumen = await toAsk(this.ASSISTANT_ID, "GET_RESUMEN", this.state);
            const data: GenericResumenData = extraerDatosResumen(resumen);
            const tipo = data.tipo || "SI_RESUMEN";
            if (tipo === "SI_RESUMEN") {
                if (this.state) delete this.state.reconectionFlow;
                await this.onSuccess(data);
                return;
            } else if (tipo === "NO_REPORTAR_BAJA") {
                if (this.state) delete this.state.reconectionFlow;
                // No hacer nada más, terminar el ciclo
                await this.onFail();
                return;
            } else if (tipo === "NO_REPORTAR_SEGUIR") {
                // No relanzar idleFlow ni nueva instancia, continuar el ciclo en esta misma instancia
                // Simplemente continuar el while para el siguiente intento de seguimiento
                continue;
            }
        }
        // Limpiar el estado de reconexión al fallar
        if (this.state) delete this.state.reconectionFlow;
        await this.onFail();
    }

    /**
     * Espera la respuesta del usuario o el timeout, lo que ocurra primero.
     * Sólo considera mensajes de usuario reales (no vacíos, no de bots, no de grupos, no de broadcasts, no de sistemas).
     */
    private waitForUserResponse(jid: string, timeout: number): Promise<boolean> {
        return new Promise((resolve) => {
            let responded = false;
            // Suscribirse a los mensajes entrantes del usuario
            const onMessage = async (msg: any) => {
                // Filtro robusto de mensajes
                const msgFrom = msg.from && msg.from.endsWith('@s.whatsapp.net') ? msg.from : `${msg.from}@s.whatsapp.net`;
                // Ignorar mensajes de grupos, broadcasts, sistemas, bots o vacíos
                if (
                    msgFrom !== jid ||
                    msg.isGroup ||
                    msg.isBroadcast ||
                    msg.isSystem ||
                    msg.isBot ||
                    !msg.body || typeof msg.body !== 'string' || msg.body.trim() === ''
                ) {
                    return;
                }
                // Enviar el mensaje recibido al asistente como "hola, [msj]"
                const userMsg = msg.body;
                const prompt = `hola, ${userMsg}`;
                try {
                    await toAsk(this.ASSISTANT_ID, prompt, this.state);
                } catch (err) {
                    console.error('[ReconectionFlow] Error enviando mensaje al asistente:', err);
                }
                responded = true;
                if (this.provider.off) this.provider.off('message', onMessage);
                clearTimeout(timer);
                resolve(true);
            };
            if (this.provider.on) this.provider.on('message', onMessage);

            // Timeout
            const timer = setTimeout(() => {
                if (!responded) {
                    if (this.provider.off) this.provider.off('message', onMessage);
                    resolve(false);
                }
            }, timeout);
        });
    }

    /**
     * Devuelve el estado serializable del flujo de reconexión para persistencia.
     */
    public getState() {
        return {
            attempts: this.attempts,
            // Puedes agregar más campos si necesitas persistir más información
        };
    }

    /**
     * Restaura el estado serializable del flujo de reconexión.
     */
    public restoreState(state: any) {
        if (state && typeof state.attempts === 'number') {
            this.attempts = state.attempts;
        }
    }
}