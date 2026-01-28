import { createProvider } from '@builderbot/bot';
import { BaileysProvider } from 'builderbot-provider-sherpa';
import { restoreSessionFromDb, startSessionSync } from './sessionSync';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';

export let groupProvider: any; // Tipo any para evitar conflictos de tipos estrictos por ahora

export const initGroupSender = async () => {
    console.log('🔌 [GroupSender] Iniciando Proveedor Baileys secundario para Grupos...');

    // 1. Restaurar sesión (usamos 'default' para intentar recuperar la sesión anterior si existe)
    await restoreSessionFromDb();

    // 2. Crear instancia de Baileys
    groupProvider = createProvider(BaileysProvider, {
        groupsIgnore: false,
        readStatus: false,
        // No necesitamos servidor HTTP propio para este provider secundario
    });

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
    startSessionSync();

    return groupProvider;
};
