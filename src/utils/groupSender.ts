import { groupProvider } from '../providers/instances';

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
 * Discrimina entre Grupos (Baileys) e Individuales (YCloud)
 */
export const sendToGroup = async (target: string, message: string) => {
    const isOfficialGroup = target.includes('@g.us');
    
    try {
        if (isOfficialGroup) {
            console.log(`🚀 [GroupSender] Enviando reporte a GRUPO vía Baileys a ${target}...`);
            
            if (!groupProvider) {
                console.error('❌ [GroupSender] Error: groupProvider no inicializado.');
                return false;
            }

            // Usar sendMessage del provider de BuilderBot
            await groupProvider.sendMessage(target, message, {});
            console.log(`✅ [GroupSender] Reporte enviado al grupo correctamente.`);
            return true;
        } else {
            console.log(`🚀 [Report] Enviando reporte INDIVIDUAL vía canal oficial YCloud a ${target}...`);
            const success = await sendViaYCloud(target, message);
            
            if (success) {
                console.log(`✅ [Report] Reporte enviado correctamente vía YCloud.`);
            } else {
                console.error(`❌ [Report] Falló el envío vía YCloud.`);
            }
            return success;
        }
    } catch (error: any) {
        console.error('❌ [Report] Error crítico en envío:', error.message);
        return false;
    }
};
