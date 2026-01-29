import { createProvider } from '@builderbot/bot';
import { BaileysProvider } from '@builderbot/provider-baileys';
import { restoreSessionFromDb, startSessionSync } from './sessionSync';
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';

export let groupProvider: any;
let isGroupReady = false;

/**
 * Función para enviar a Discord (Fallback opcional)
 */
export const sendToDiscord = async (message: string) => {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return false;

    try {
        await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: '📊 **Nuevo Resumen de Reserva**',
                embeds: [{
                    description: message,
                    color: 5814783
                }]
            })
        });
        console.log('✅ [Discord] Resumen enviado correctamente.');
        return true;
    } catch (e) {
        console.error('❌ [Discord] Error enviando webhook:', e);
        return false;
    }
};

/**
 * Función para enviar vía API Oficial de YCloud (Máxima fiabilidad)
 * Ideal para enviar resúmenes a números personales desde la línea del bot.
 */
export const sendViaYCloud = async (to: string, message: string) => {
    const apiKey = process.env.YCLOUD_API_KEY;
    const from = process.env.YCLOUD_WABA_NUMBER;
    
    if (!apiKey || !from) {
        console.error('❌ [YCloud-Report] Faltan credenciales YCLOUD_API_KEY o YCLOUD_WABA_NUMBER');
        return false;
    }

    const cleanNumber = to.replace(/\D/g, '');

    try {
        const response = await fetch('https://api.ycloud.com/v2/whatsapp/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': apiKey
            },
            body: JSON.stringify({
                from,
                to: cleanNumber,
                type: 'text',
                text: { body: message }
            })
        });

        const data = await response.json();
        if (response.ok) {
            console.log(`✅ [YCloud-Report] Resumen enviado oficialmente a ${cleanNumber}`);
            return true;
        } else {
            console.error('❌ [YCloud-Report] Falló el envío oficial:', data);
            return false;
        }
    } catch (e) {
        console.error('❌ [YCloud-Report] Error en petición API:', e);
        return false;
    }
};

/**
 * Función principal para envío de resúmenes.
 * Decide automáticamente si usar YCloud (para números) o Baileys (para grupos).
 */
export const sendToGroup = async (target: string, message: string) => {
    // 1. Prioridad: Determinar si usamos la línea oficial (YCloud)
    // Se usa si target es un número común o si existe REPORT_PHONE_NUMBER
    const adminNumber = process.env.REPORT_PHONE_NUMBER || (target && !target.includes('@g.us') ? target : null);
    
    if (adminNumber) {
        console.log(`🚀 [Report] Redirigiendo reporte a línea oficial YCloud (${adminNumber})...`);
        return await sendViaYCloud(adminNumber, message);
    }

    // 2. Fallback: Grupos de WhatsApp (Baileys)
    if (!groupProvider?.vendor?.user) {
        console.warn('⚠️ [GroupSender] WhatsApp Grupos no conectado. Intentando Discord si existe...');
        if (process.env.DISCORD_WEBHOOK_URL) await sendToDiscord(message);
        return;
    }

    const vendor = groupProvider.vendor;
    try {
        console.log(`� [GroupSender] Intentando envío a grupo ${target}...`);
        await vendor.sendMessage(target, { text: message });
        console.log(`✅ [GroupSender] Enviado a WhatsApp (Grupo).`);
    } catch (error: any) {
        console.error('❌ [GroupSender] Error enviando al grupo WhatsApp.');
        if (process.env.DISCORD_WEBHOOK_URL) await sendToDiscord(message);
        throw error;
    }
};

export const initGroupSender = async () => {
    console.log('🔌 [GroupSender] Iniciando Módulo de Reportes...');

    try {
        await restoreSessionFromDb('groups');

        groupProvider = createProvider(BaileysProvider, {
            version: [2, 3000, 1030817285],
            groupsIgnore: false,
            readStatus: false,
            disableHttpServer: true,
            authTimeoutMs: 60000 
        });

        groupProvider.on('require_action', async (payload: any) => {
            isGroupReady = false;
            const qrString = payload?.payload?.qr || payload?.qr || (typeof payload === 'string' ? payload : null);

            if (qrString && qrString.length > 20) {
                console.log('⚡ [GroupSender] Generando QR de grupos...');
                const qrPath = path.join(process.cwd(), 'bot.groups.qr.png');
                await QRCode.toFile(qrPath, qrString, { scale: 10, margin: 2 });
            }
        });

        groupProvider.on('ready', () => {
            if (!isGroupReady) {
                console.log('✅ [GroupSender] Motor de grupos LISTO.');
                isGroupReady = true;
                const qrPath = path.join(process.cwd(), 'bot.groups.qr.png');
                if (fs.existsSync(qrPath)) fs.unlinkSync(qrPath);
            }
        });

        groupProvider.on('message', (ctx: any) => {
            // Sincronización silenciosa
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
