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
        setTimeout(() => {
            this.emit('ready', true);
        }, 100);
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
        const fromNumber = process.env.YCLOUD_WABA_NUMBER;

        if (!apiKey) {
            console.error('[YCloudProvider] Error: YCLOUD_API_KEY no definida en variables de entorno.');
            return;
        }

        if (!fromNumber) {
            console.error('[YCloudProvider] Error: YCLOUD_WABA_NUMBER no definida en variables de entorno. Es necesaria para el parámetro "from".');
            return;
        }

        const url = 'https://api.ycloud.com/v2/whatsapp/messages';

        // Limpiar el número de destino (quitar +, espacios, etc)
        const cleanNumber = number.replace(/\D/g, '');

        const body: any = {
            from: fromNumber.replace(/\D/g, ''), // El número desde el cual enviamos (tu WABA number)
            to: cleanNumber,
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
            console.log(`📤 [YCloudProvider] Mensaje enviado exitosamente a ${cleanNumber}`);
            return response.data;
        } catch (error: any) {
            console.error('[YCloudProvider] ❌ Error enviando mensaje:', JSON.stringify(error?.response?.data || error.message, null, 2));
            return Promise.resolve(null);
        }
    }

    /**
     * Método para procesar el Webhook entrante desde app.ts
     */
    public handleWebhook = (req: any, res: any) => {
        try {
            const body = req.body;
            console.log('📬 [YCloudProvider] Webhook recibido:', JSON.stringify(body));

            if (!body) {
                console.warn('⚠️ [YCloudProvider] Webhook recibido sin cuerpo (body)');
                return res.end('No body');
            }
            if (body.type === 'whatsapp.inbound_message.received' && body.whatsappInboundMessage) {
                const msg = body.whatsappInboundMessage;
                
                // Mapear evento al formato de BuilderBot
                const formatedMessage = {
                    body: msg.text?.body || 
                          msg.interactive?.button_reply?.title || 
                          msg.interactive?.list_reply?.title || 
                          msg.button?.text || '',
                    from: msg.wa_id || msg.from.replace('+', ''),
                    phoneNumber: msg.from.replace('+', ''),
                    name: msg.customerProfile?.name || 'User',
                    type: msg.type,
                    payload: msg
                };

                console.log(`📩 [YCloudProvider] Emitiendo mensaje de ${formatedMessage.from}: ${formatedMessage.body}`);
                this.emit('message', formatedMessage);
            } 
            // 2. Formato Meta (WhatsApp Business Account / Cloud API)
            else if (body.object === 'whatsapp_business_account' || body.entry) {
                console.log('📬 [YCloudProvider] Detectado formato Meta/Cloud API');
                body.entry?.forEach((entry: any) => {
                    entry.changes?.forEach((change: any) => {
                        if (change.value?.messages) {
                            // Extraer wa_id del contacto si existe (es más estable para Brasil)
                            const contact = change.value?.contacts?.[0];
                            const wa_id = contact?.wa_id;

                            change.value.messages.forEach((msg: any) => {
                                const formatedMessage = {
                                    body: msg.text?.body || 
                                          msg.interactive?.button_reply?.title || 
                                          msg.interactive?.list_reply?.title || 
                                          msg.button?.text || '',
                                    from: wa_id || msg.from.replace('+', ''),
                                    phoneNumber: msg.from.replace('+', ''),
                                    name: contact?.profile?.name || msg.profile?.name || 'User',
                                    type: msg.type,
                                    payload: msg
                                };
                                console.log(`📩 [YCloudProvider] Emitiendo mensaje (Meta) de ${formatedMessage.from}: ${formatedMessage.body}`);
                                this.emit('message', formatedMessage);
                            });
                        }
                    });
                });
            } else {
                console.warn('⚠️ [YCloudProvider] Formato de webhook no reconocido');
            }

            // Responder 200 OK para confirmar recepción a YCloud
            if (!res.headersSent) {
                res.statusCode = 200;
                res.end('OK');
            }
        } catch (e) {
            console.error('[YCloudProvider] Error parsing webhook:', e);
            if (!res.headersSent) {
                res.statusCode = 500;
                res.end('Error');
            }
        }
    }
}

export { YCloudProvider };
