import { addKeyword, EVENTS } from '@builderbot/bot';
import { toAsk } from '@builderbot-plugins/openai-assistants';
import { GenericResumenData, extraerDatosResumen } from '~/utils/extractJsonData';
import { addToSheet } from '~/utils/googleSheetsResumen';
import { ReconectionFlow } from './reconectionFlow';

//** Variables de entorno para el envio de msj de resumen a grupo de WS */
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? '';
const ID_GRUPO_RESUMEN = process.env.ID_GRUPO_RESUMEN ?? '';
const msjCierre: string = process.env.msjCierre as string;

//** Flow para cierre de conversación, generación de resumen y envio a grupo de WS */
const idleFlow = addKeyword(EVENTS.ACTION).addAction(
    async (ctx, { endFlow, provider, state }) => {
        console.log("Ejecutando idleFlow...");

        try {
            // Obtener el resumen del asistente de OpenAI
            const resumen = await toAsk(ASSISTANT_ID, "GET_RESUMEN", state);

            if (!resumen) {
                console.warn("No se pudo obtener el resumen.");
                return endFlow();
            }

            let data: GenericResumenData;
            try {
                data = JSON.parse(resumen);
            } catch (error) {
                console.warn("⚠️ El resumen no es JSON. Se extraerán los datos manualmente.");
                data = extraerDatosResumen(resumen);
            }

            // Log para depuración del valor real de tipo
            console.log('Valor de tipo:', JSON.stringify(data.tipo), '| Longitud:', data.tipo?.length);
            // Limpieza robusta de caracteres invisibles y espacios
            const tipo = (data.tipo ?? '').replace(/[^A-Z_]/gi, '').toUpperCase();

            // Función auxiliar local para manejar el envío al grupo
            const handleGroupSending = async () => {
                const resumenConLink = `${resumen}\n\n🔗 [Chat del usuario](${data.linkWS})`;
                try {
                    // Usar provider directamente (YCloud) en lugar de groupSender externo
                    console.log(`🚀 [Report] Enviando reporte vía provider (YCloud) a ${ID_GRUPO_RESUMEN}...`);
                    await provider.sendMessage(ID_GRUPO_RESUMEN, resumenConLink, {});
                    console.log(`✅ [Report] Reporte enviado vía provider.`);
                } catch (err) {
                    console.error(`❌ Error enviando resumen al grupo ${ID_GRUPO_RESUMEN}:`, err?.message || err);
                }
            };

            data.linkWS = `https://wa.me/${ctx.from.replace(/[^0-9]/g, '')}`;

            if (tipo === 'NO_REPORTAR_BAJA') {
                console.log('NO_REPORTAR_BAJA: No se realiza seguimiento ni se envía resumen al grupo.');
                await addToSheet(data);
                return endFlow();
            } else if (tipo === 'NO_REPORTAR_SEGUIR') {
                console.log('NO_REPORTAR_SEGUIR: Se realiza seguimiento, pero no se envía resumen al grupo.');
                const reconFlow = new ReconectionFlow({
                    ctx,
                    state,
                    provider,
                    maxAttempts: 3,
                    onSuccess: async (newData) => {
                        if (typeof ctx.gotoFlow === 'function') {
                            if (ctx.type === 'voice_note' || ctx.type === 'VOICE_NOTE') {
                                const mod = await import('./welcomeFlowVoice');
                                await ctx.gotoFlow(mod.welcomeFlowVoice);
                            } else {
                                const mod = await import('./welcomeFlowTxt');
                                await ctx.gotoFlow(mod.welcomeFlowTxt);
                            }
                        }
                    },
                    onFail: async () => {
                        await addToSheet(data);
                    }
                });
                return await reconFlow.start();
            } else if (tipo === 'SI_RESUMEN') {
                console.log('SI_RESUMEN: Solo se envía resumen al grupo y sheets.');
                await handleGroupSending();
                await addToSheet(data);
                return;
            } else {
                console.log('Tipo desconocido/DEFAULT. Procesando como SI_RESUMEN.');
                await handleGroupSending();
                await addToSheet(data);
                return;
            }

        } catch (error) {
            console.error("Error al obtener el resumen de OpenAI:", error);
            return endFlow();
        }
    }
);

export { idleFlow };