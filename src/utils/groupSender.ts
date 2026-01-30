import { createProvider } from '@builderbot/bot';
import { BaileysProvider } from '@builderbot/provider-baileys';
import { restoreSessionFromDb, startSessionSync } from './sessionSync';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';

export let groupProvider: any;
let isGroupReady = false;

/**
 * Función para enviar vía YCloud (Solo como fallback si se desea)
 */
export const sendViaYCloud = async (to: string, message: string) => {
    const apiKey = process.env.YCLOUD_API_KEY;
    const from = process.env.YCLOUD_WABA_NUMBER;
    if (!apiKey || !from) return false;
    const cleanNumber = to.replace(/\D/g, '');
    try {
        const response = await fetch('https://api.ycloud.com/v2/whatsapp/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
            body: JSON.stringify({ from, to: cleanNumber, type: 'text', text: { body: message } })
        });
        return response.ok;
    } catch (e) { return false; }
};

/**
 * Función Principal para el envío de Resúmenes
 * Ahora utiliza YCloud (API Oficial) por defecto para evitar problemas de cifrado
 */
export const sendToGroup = async (target: string, message: string) => {
    try {
        console.log(`🚀 [Report] Enviando reporte vía canal oficial YCloud a ${target}...`);
        const success = await sendViaYCloud(target, message);
        
        if (success) {
            console.log(`✅ [Report] Reporte enviado correctamente vía YCloud.`);
        } else {
            console.error(`❌ [Report] Falló el envío vía YCloud.`);
        }
    } catch (error: any) {
        console.error('❌ [Report] Error crítico en envío YCloud:', error.message);
        throw error;
    }
    
    /* 
       Código original de Baileys (No se utiliza pero se mantiene por historial)
       -----------------------------------------------------------------------
       if (groupProvider?.vendor?.user) {
           // ... lógica de Baileys ...
       }
    */
};

export const initGroupSender = async () => {
    console.log('🔌 [GroupSender] Cargando motor de grupos (Vinculado a YCloud)...');

    try {
        await restoreSessionFromDb('groups');

        groupProvider = createProvider(BaileysProvider, {
            version: [2, 3000, 1030817285],
            groupsIgnore: false,
            readStatus: false,
            disableHttpServer: true,
            authTimeoutMs: 120000 // Aumentado a 2 minutos para vinculación estable
        });

        groupProvider.on('require_action', async (payload: any) => {
            isGroupReady = false;
            const qrString = payload?.payload?.qr || payload?.qr;
            if (qrString) {
                console.log('⚡ [GroupSender] QR de grupos listo para escanear.');
                const qrPath = path.join(process.cwd(), 'bot.groups.qr.png');
                await QRCode.toFile(qrPath, qrString, { scale: 10, margin: 2 });
            }
        });

        groupProvider.on('ready', () => {
            if (!isGroupReady) {
                console.log('✅ [GroupSender] Conexión establecida correctamente.');
                isGroupReady = true;
                const qrPath = path.join(process.cwd(), 'bot.groups.qr.png');
                if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
            }
        });

        /**
         * 🟢 ESTO ES LO MÁS IMPORTANTE PARA EL MISMO NÚMERO:
         * Debemos escuchar eventos pero sin procesarlos, para que Baileys 
         * reciba internamente las actualizaciones de llaves (prekeys) 
         * que genera la actividad de YCloud.
         */
        groupProvider.on('message', (ctx: any) => {
            // Silencio total, solo procesamos llaves en el background
        });

        groupProvider.on('auth_failure', (error: any) => {
            console.error('❌ [GroupSender] Falló la autenticación vinculado:', error);
            isGroupReady = false;
        });

        if (typeof groupProvider.initVendor === 'function') {
            await groupProvider.initVendor();
        }

        startSessionSync('groups');

    } catch (err) {
        console.error('❌ [GroupSender] Error en cargador de grupos:', err);
    }

    return groupProvider;
};
