import { createProvider } from '@builderbot/bot';
import { BaileysProvider } from '@builderbot/provider-baileys';
import { restoreSessionFromDb, startSessionSync } from './sessionSync';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';

export let groupProvider: any;
let isGroupReady = false;

/**
 * Función robusta para enviar mensajes a grupos
 */
export const sendToGroup = async (number: string, message: string) => {
    if (!groupProvider) {
        throw new Error('GroupProvider no inicializado.');
    }

    const vendor = groupProvider.vendor;
    
    if (!vendor || !vendor.user) {
        throw new Error('Sesión de grupos no conectada. Por favor, escanea el QR en /groups-qr.png');
    }

    // Esperar un momento si acaba de conectar
    if (!isGroupReady) {
        console.log('[GroupSender] El bot aún se está sincronizando... esperando 3s.');
        await new Promise(res => setTimeout(res, 3000));
    }

    try {
        console.log(`📤 [GroupSender] Validando grupo y enviando a ${number}...`);
        
        // FORZAR SINCRONIZACIÓN DE LLAVES: 
        // Consultar los metadatos del grupo antes de enviar suele solucionar el error 'No sessions'
        // ya que obliga a Baileys a obtener las llaves de los participantes.
        try {
            if (vendor.groupMetadata) {
                await vendor.groupMetadata(number);
                console.log(`[GroupSender] Metadatos del grupo obtenidos correctamente.`);
            }
        } catch (e: any) {
            console.warn(`[GroupSender] No se pudieron obtener metadatos (podría ser normal):`, e.message);
        }

        //@ts-ignore
        await groupProvider.sendMessage(number, message, {});
        console.log(`✅ [GroupSender] Mensaje enviado.`);
    } catch (error: any) {
        const errorMsg = error?.message || String(error);
        
        if (errorMsg.includes('No sessions') || errorMsg.includes('SessionError')) {
            console.error('❌ [GroupSender] Error de Cifrado (No sessions).');
            console.log('[GroupSender] Sugerencia: El bot necesita que el administrador del grupo lo salude o que alguien escriba en el grupo para refrescar llaves.');
            throw new Error('Error de cifrado en el grupo. Intenta escribir algo manualmente en el grupo desde el móvil del bot.');
        }

        const isConnectionError = errorMsg.includes('Connection Closed') ||
            errorMsg.includes('closed') ||
            errorMsg.includes('not open') ||
            errorMsg.includes('undefined (reading \'id\')');

        if (isConnectionError) {
            console.warn('⚠️ [GroupSender] Error de conexión. Reintentando...');
            
            try {
                if (groupProvider.initVendor) await groupProvider.initVendor();
                await new Promise(res => setTimeout(res, 3000));
                
                if (groupProvider.vendor?.user) {
                    await groupProvider.sendMessage(number, message, {});
                    console.log(`✅ [GroupSender] Enviado tras recuperar conexión.`);
                    return;
                }
            } catch (e) {
                console.error('[GroupSender] Falló el reintento de envío:', e);
            }
        }
        throw error;
    }
};

export const initGroupSender = async () => {
    console.log('🔌 [GroupSender] Iniciando Proveedor Baileys secundario para Grupos...');

    try {
        await restoreSessionFromDb('groups');

        // 2. Crear instancia de Baileys estándar con versión forzada
        // 2. Restaurar createProvider con la versión específica que evitaba el error 405
        groupProvider = createProvider(BaileysProvider, {
            version: [2, 3000, 1030817285],
            groupsIgnore: false,
            readStatus: false,
            disableHttpServer: true,
        });

        groupProvider.on('require_action', async (payload: any) => {
            isGroupReady = false; // Si pide QR, ya no está listo
            const qrString = payload?.payload?.qr || payload?.qr || (typeof payload === 'string' ? payload : null);

            if (qrString && qrString.length > 20) {
                console.log('⚡ [GroupSender] Generando QR de grupos...');
                const qrPath = path.join(process.cwd(), 'bot.groups.qr.png');
                await QRCode.toFile(qrPath, qrString, { scale: 10, margin: 2 });
            }
        });

        groupProvider.on('ready', () => {
            if (!isGroupReady) {
                console.log('✅ [GroupSender] Conexión establecida. LISTO.');
                isGroupReady = true;
                const qrPath = path.join(process.cwd(), 'bot.groups.qr.png');
                if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
            }
        });

        groupProvider.on('auth_failure', (error: any) => {
            console.error('❌ [GroupSender] Autenticación fallida:', error);
            isGroupReady = false;
        });

        if (typeof groupProvider.initVendor === 'function') {
            await groupProvider.initVendor();
        }

        startSessionSync('groups');

    } catch (err) {
        console.error('❌ [GroupSender] Error en inicio:', err);
    }

    return groupProvider;
};
