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

    try {
        console.log(`📤 [GroupSender] Enviando a ${number}...`);
        //@ts-ignore
        await groupProvider.sendMessage(number, message, {});
        console.log(`✅ [GroupSender] Mensaje enviado.`);
    } catch (error: any) {
        const errorMsg = error?.message || String(error);
        
        // El error 'No sessions' es crítico: significa que los archivos de sesión están dañados.
        if (errorMsg.includes('No sessions') || errorMsg.includes('SessionError')) {
            console.error('❌ [GroupSender] Error Crítico: Sesión corrupta (No sessions). Forzando limpieza local...');
            
            // Intentar borrar groups_sessions localmente para forzar QR en el siguiente reinicio
            try {
                const sessionsDir = path.join(process.cwd(), 'groups_sessions');
                if (fs.existsSync(sessionsDir)) {
                    fs.rmSync(sessionsDir, { recursive: true, force: true });
                    console.log('✅ [GroupSender] Carpeta groups_sessions eliminada preventivamente.');
                }
            } catch (e) {
                console.error('[GroupSender] No se pudo limpiar la carpeta local:', e);
            }

            throw new Error('La sesión de grupos está dañada. Por favor, ve al Dashboard y usa "Borrar Sesión y Reiniciar" para limpiar la nube también.');
        }

        const isConnectionError = errorMsg.includes('Connection Closed') ||
            errorMsg.includes('closed') ||
            errorMsg.includes('not open') ||
            errorMsg.includes('undefined (reading \'id\')');

        if (isConnectionError) {
            console.warn('⚠️ [GroupSender] Error de conexión. Intentando recuperar una vez...');
            
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
