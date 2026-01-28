import { ProviderClass } from '@builderbot/bot';
import axios from 'axios';
import { EventEmitter } from 'events';

class YCloudProvider extends ProviderClass {
    globalVendorArgs: any;

    constructor(args: any = {}) {
        super();
        this.globalVendorArgs = args;
    }

    protected initProvider() {
        console.log('[YCloudProvider] Listo. Esperando Webhooks...');
    }

    // Métodos requeridos por ProviderClass para evitar errores de clase abstracta

    public async initVendor() {
        // En un provider basado en API vacía, el vendor puede ser un objeto simple o null.
        // Lo definimos para cumplir el contrato.
        this.vendor = {};
        return this.vendor;
    }

    public beforeHttpServerInit() {
        // No se requiere acción previa al levantar servidor
    }

    public afterHttpServerInit() {
        // No se requiere acción posterior al levantar servidor
    }

    public busEvents = () => {
        // Retorna array de eventos si fuera necesario
        return [];
    };

    public saveFile() {
        // No guardamos archivos de sesión locales en este provider API
        return Promise.resolve('no-file');
    }


    /**
     * Manda mensajes a través de la API de YCloud
     * DEBE SER PUBLIC para cumplir con la firma de ProviderClass
     */
    public async sendMessage(number: string, message: string, options: any = {}): Promise<any> {
        // Asegurarse de tener la API Key
        const apiKey = process.env.YCLOUD_API_KEY;
        if (!apiKey) {
            console.error('[YCloudProvider] Error: YCLOUD_API_KEY no definida en variables de entorno.');
            return;
        }

        const url = 'https://api.ycloud.com/v2/whatsapp/messages';

        const body: any = {
            to: number,
            type: 'text',
            text: { body: message }
        };

        // Soporte básico para opciones media si fuera necesario en el futuro
        if (options.media) {
            console.warn('[YCloudProvider] El envío de media no está completamente implementado en este adaptador básico.');
        }

        try {
            const response = await axios.post(url, body, {
                headers: {
                    'X-API-Key': apiKey,
                    'Content-Type': 'application/json'
                }
            });
            return response.data;
        } catch (error: any) {
            console.error('[YCloudProvider] Error enviando mensaje:', error?.response?.data || error.message);
            return Promise.resolve(null);
        }
    }

    /**
     * Método para procesar el Webhook entrante desde app.ts
     */
    public handleWebhook = (req: any, res: any) => {
        try {
            const body = req.body;
            // Estructura típica de Meta/YCloud para mensajes entrantes
            // Documentación YCloud: https://docs.ycloud.com/reference/whatsapp-inbound-message-webhook-examples

            // Verificamos si es un evento de mensaje entrante
            if (body.object === 'whatsapp_business_account' || body.entry) {
                body.entry?.forEach((entry: any) => {
                    entry.changes?.forEach((change: any) => {
                        if (change.value?.messages) {
                            change.value.messages.forEach((msg: any) => {
                                // Mapear evento al formato de BuilderBot
                                // from: número del usuario
                                // body: contenido del mensaje
                                const formatedMessage = {
                                    body: msg.text?.body || '',
                                    from: msg.from,
                                    name: msg.profile?.name || 'User',
                                    type: msg.type,
                                    payload: msg
                                };

                                // Emitir evento 'message' que consume el bot
                                this.emit('message', formatedMessage);
                            });
                        }
                    });
                });
            }

            // Responder 200 OK para confirmar recepción a YCloud
            if (!res.headersSent) {
                res.sendStatus(200);
            }
        } catch (e) {
            console.error('[YCloudProvider] Error parsing webhook:', e);
            if (!res.headersSent) {
                res.sendStatus(500);
            }
        }
    }
}

export { YCloudProvider };
