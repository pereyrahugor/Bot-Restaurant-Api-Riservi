import { createProvider } from '@builderbot/bot';
import { BaileysProvider } from '@builderbot/provider-baileys';
import { restoreSessionFromDb, startSessionSync } from './sessionSync';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';

export let groupProvider: any; // Tipo any para evitar conflictos de tipos estrictos por ahora

/**
 * Función robusta para enviar mensajes a grupos
 */
export const sendToGroup = async (number: string, message: string) => {
    if (!groupProvider) {
        console.error('❌ [GroupSender] GroupProvider no está instanciado.');
        throw new Error('GroupProvider no inicializado.');
    }

    // Verificar estado del vendor (socket de Baileys)
    const vendor = groupProvider.vendor;
    
    if (!vendor || !vendor.user) {
        console.error('❌ [GroupSender] El socket no está autenticado o conectado (vendor.user is undefined).');
        throw new Error('Sesión de grupos no conectada. Por favor, escanea el QR de grupos.');
    }

    try {
        console.log(`📤 [GroupSender] Intentando enviar a ${number}...`);
        //@ts-ignore
        await groupProvider.sendMessage(number, message, {});
        console.log(`✅ [GroupSender] Mensaje enviado correctamente.`);
    } catch (error: any) {
        console.error('❌ [GroupSender] Error en sendMessage:', error);
        
        const errorMsg = error?.message || String(error);
        const isConnectionError = errorMsg.includes('Connection Closed') ||
            errorMsg.includes('closed') ||
            errorMsg.includes('not open') ||
            errorMsg.includes('undefined (reading \'id\')');

        if (isConnectionError) {
            console.warn('⚠️ [GroupSender] Error de conexión o sesión inválida detectada. Reintentando...');
            await new Promise(res => setTimeout(res, 2000));

            try {
                if (groupProvider.initVendor) {
                    console.log('[GroupSender] Re-inicializando vendor...');
                    await groupProvider.initVendor();
                }
            } catch (e) {
                console.error('[GroupSender] Error al re-inicializar vendor:', e);
            }

            // Reintento final si el vendor se recuperó
            if (groupProvider.vendor && groupProvider.vendor.user) {
                await groupProvider.sendMessage(number, message, {});
                console.log(`✅ [GroupSender] Mensaje enviado en reintento.`);
            } else {
                throw new Error('No se pudo recuperar la conexión del grupo. Escanee el QR nuevamente.');
            }
        } else {
            throw error;
        }
    }
};

export const initGroupSender = async () => {
    console.log('🔌 [GroupSender] Iniciando Proveedor Baileys secundario para Grupos...');

    try {
        // 1. Restaurar sesión (usamos 'groups' para separar la sesión de grupos del bot principal)
        await restoreSessionFromDb('groups');

        // 2. Crear instancia de Baileys con versión específica para evitar errores de conexión
        groupProvider = createProvider(BaileysProvider, {
            version: [2, 3000, 1030817285],
            groupsIgnore: false,
            readStatus: false,
            disableHttpServer: true,
        });

        // 3. Manejo de eventos para diagnóstico
        groupProvider.on('require_action', async (payload: any) => {
            console.log(`[GroupSender] Evento require_action recibido a las ${new Date().toLocaleTimeString()}`);
            console.log(`[GroupSender] Payload completo:`, JSON.stringify(payload));

            let qrString = null;

            // Intento de captura de QR en diferentes estructuras posibles
            if (typeof payload === 'string' && payload.length > 20) {
                qrString = payload;
            } else if (payload?.payload?.qr) { // Caso específico detectado en logs de Railway
                qrString = payload.payload.qr;
            } else if (payload?.qr) {
                qrString = payload.qr;
            } else if (payload?.payload?.code) {
                qrString = payload.payload.code;
            }

            if (qrString) {
                console.log('⚡ [GroupSender] Cadena QR detectada. Generando archivo bot.groups.qr.png...');
                try {
                    const qrPath = path.join(process.cwd(), 'bot.groups.qr.png');
                    await QRCode.toFile(qrPath, qrString, { 
                        scale: 10,  // Aumentar escala para mejor lectura
                        margin: 2,
                        color: {
                            dark: '#000000',
                            light: '#ffffff'
                        }
                    });
                    console.log(`✅ [GroupSender] QR escrito físicamente en: ${qrPath}`);
                } catch (qrErr) {
                    console.error('❌ [GroupSender] Error al escribir el archivo QR:', qrErr);
                }
            } else {
                console.warn('⚠️ [GroupSender] Se recibió require_action pero no se encontró una cadena QR válida en el payload.');
            }
        });

        groupProvider.on('ready', () => {
            console.log('✅ [GroupSender] Conexión establecida. El bot de grupos está LISTO.');
            // Eliminar QR viejo si existe al conectar
            const qrPath = path.join(process.cwd(), 'bot.groups.qr.png');
            if (fs.existsSync(qrPath)) {
                fs.unlinkSync(qrPath);
                console.log('[GroupSender] QR temporal de grupos eliminado.');
            }
        });

        groupProvider.on('auth_failure', (error: any) => {
            console.error('❌ [GroupSender] Error de autenticación:', error);
        });

        // 4. Forzar inicialización del Vendor (Socket)
        if (typeof groupProvider.initVendor === 'function') {
            console.log('🔌 [GroupSender] Ejecutando initVendor() manualmente...');
            await groupProvider.initVendor();
            console.log('🔌 [GroupSender] Llamada a initVendor() terminada. Esperando eventos...');
        }

        // 5. Iniciar sincronización de sesión
        startSessionSync('groups');

    } catch (err) {
        console.error('❌ [GroupSender] Error crítico durante la inicialización:', err);
    }

    return groupProvider;
};
