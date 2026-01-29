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
        const botId = vendor.user.id.split(':')[0];
        console.log(`📤 [GroupSender] Identidad del Bot: ${botId}. Preparando envío a grupo...`);
        
        try {
            // ESTRATEGIA DEFINITIVA PARA 'No sessions':
            // 1. Obtener miembros del grupo
            const metadata = await vendor.groupMetadata(number);
            const participants = metadata.participants.map(p => p.id);
            
            console.log(`[GroupSender] Sincronizando llaves e2e para ${participants.length} participantes...`);
            
            // 2. Forzar al bot a "ver" a los participantes. 
            // Esto puebla el almacén de llaves (store) de Baileys.
            if (vendor.onWhatsApp) {
                // Solo los primeros 5 miembros para no saturar, suele ser suficiente para despertar el cifrado
                await vendor.onWhatsApp(...participants.slice(0, 5));
            }
            
            if (vendor.sendPresenceUpdate) await vendor.sendPresenceUpdate('composing', number);
            await new Promise(res => setTimeout(res, 2000));
        } catch (e: any) {
            console.warn(`[GroupSender] Aviso en pre-sincronización:`, e.message);
        }

        // 3. ENVÍO NATIVO
        await vendor.sendMessage(number, { text: message });
        
        console.log(`✅ [GroupSender] Mensaje enviado exitosamente.`);
        
        try { if (vendor.sendPresenceUpdate) await vendor.sendPresenceUpdate('paused', number); } catch(e){}
    } catch (error: any) {
        const errorMsg = error?.message || String(error);
        
        if (errorMsg.includes('No sessions') || errorMsg.includes('SessionError')) {
            console.error('❌ [GroupSender] Error Crítico de Cifrado.');
            console.log('💡 Tip: Asegúrate de que el número del bot NO tenga chats archivados o bloqueados con miembros de este grupo.');
            throw new Error('Sincronizando seguridad del grupo... Por favor, intenta de nuevo en 10 segundos.');
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
        // 2. Restaurar createProvider con configuración estándar para evitar crash
        groupProvider = createProvider(BaileysProvider, {
            version: [2, 3000, 1030817285],
            groupsIgnore: false,
            readStatus: false,
            disableHttpServer: true,
            //@ts-ignore - Aumentar timeout para evitar cierres prematuros durante QR
            authTimeoutMs: 60000 
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

        // IMPORTANTE: Un listener aunque sea vacío obliga a Baileys a procesar 
        // paquetes de seguridad (llaves) recibidos del servidor.
        groupProvider.on('message', (ctx: any) => {
            // No hacemos nada, solo mantenemos el canal de sincronización abierto
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
