import { createProvider } from '@builderbot/bot';
import { BaileysProvider } from 'builderbot-provider-sherpa';
import { restoreSessionFromDb, startSessionSync } from './sessionSync';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';

export let groupProvider: any; // Tipo any para evitar conflictos de tipos estrictos por ahora

/**
 * Función robusta para enviar mensajes a grupos
 * Maneja reintentos básicos por conexión cerrada
 */
export const sendToGroup = async (number: string, message: string) => {
    if (!groupProvider) {
        throw new Error('GroupProvider no inicializado.');
    }

    // Verificar si el vendor interna existe
    if (!groupProvider.vendor) {
        console.warn('⚠️ [GroupSender] Vendor no detectado. Intentando inicializar...');
        await groupProvider.initVendor();
        await new Promise(res => setTimeout(res, 2000)); // Esperar un poco a que conecte
    }

    try {
        console.log(`📤 [GroupSender] Enviando mensaje a ${number}...`);
        await groupProvider.sendMessage(number, message, {});
        console.log(`✅ [GroupSender] Mensaje enviado correctamente.`);
    } catch (error: any) {
        const isConnectionError = error?.message?.includes('Connection Closed') ||
            error?.message?.includes('closed') ||
            error?.message?.includes('not open');

        if (isConnectionError) {
            console.warn('⚠️ [GroupSender] Error de conexión detectado. Reintentando en 3 segundos...');
            await new Promise(res => setTimeout(res, 3000));

            // Intento de reconexión ligero (initVendor suele ser idempotente o reinicia)
            try {
                if (groupProvider.initVendor) await groupProvider.initVendor();
            } catch (e) {
                console.error('[GroupSender] Error al re-inicializar vendor:', e);
            }

            // Reintento final
            await groupProvider.sendMessage(number, message, {});
            console.log(`✅ [GroupSender] Mensaje enviado en reintento.`);
        } else {
            throw error;
        }
    }
};

export const initGroupSender = async () => {
    console.log('🔌 [GroupSender] Iniciando Proveedor Baileys secundario para Grupos...');

    // 1. Restaurar sesión (usamos 'groups' para separar la sesión de grupos del bot principal)
    await restoreSessionFromDb('groups');

    // 2. Crear instancia de Baileys
    groupProvider = createProvider(BaileysProvider, {
        groupsIgnore: false,
        readStatus: false,
        // No necesitamos servidor HTTP propio para este provider secundario
    });

    // 2.1 Forzar inicialización del Vendor (Socket) ya que no usamos createBot
    if (typeof groupProvider.initVendor === 'function') {
        console.log('🔌 [GroupSender] Inicializando vendor manualmente...');
        await (groupProvider as any).initVendor();
    }

    // 3. Manejo de QR específico para este provider
    groupProvider.on('require_action', async (payload: any) => {
        let qrString = null;
        if (typeof payload === 'string') qrString = payload;
        else if (payload?.qr) qrString = payload.qr;
        else if (payload?.code) qrString = payload.code;

        if (qrString) {
            console.log('⚡ [GroupSender] QR generado. Nombre: bot.groups.qr.png');
            try {
                const qrPath = path.join(process.cwd(), 'bot.groups.qr.png');
                await QRCode.toFile(qrPath, qrString, { scale: 4, margin: 2 });
                console.log(`✅ [GroupSender] QR imagen guardada en: ${qrPath}`);
            } catch (err) {
                console.error('❌ [GroupSender] Error generando imagen QR:', err);
            }
        }
    });

    groupProvider.on('ready', () => {
        console.log('✅ [GroupSender] Provider de Grupos conectado y listo.');
    });

    // 4. Iniciar sincronización de sesión
    startSessionSync('groups');

    return groupProvider;
};
