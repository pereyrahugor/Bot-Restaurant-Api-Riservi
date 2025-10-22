import { addKeyword, EVENTS } from '@builderbot/bot';
import { toAsk } from '@builderbot-plugins/openai-assistants';
import { GenericResumenData, extraerDatosResumen } from '~/utils/extractJsonData';
import { addToSheet } from '~/utils/googleSheetsResumen';
import fs from 'fs';
import path from 'path';// Import the new logic
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

                if (tipo === 'NO_REPORTAR_BAJA') {
                    // No seguimiento, no enviar resumen al grupo ws, envia resumen a sheet, envia msj de cierre
                    console.log('NO_REPORTAR_BAJA: No se realiza seguimiento ni se envía resumen al grupo.');
                    data.linkWS = `https://wa.me/${ctx.from.replace(/[^0-9]/g, '')}`;
                    await addToSheet(data);
                    return endFlow(); //("BNI, cambiando la forma en que el mundo hace negocios\nGracias por su contacto.");
                } else if (tipo === 'NO_REPORTAR_SEGUIR') {
                    // Solo este activa seguimiento
                    console.log('NO_REPORTAR_SEGUIR: Se realiza seguimiento, pero no se envía resumen al grupo.');
                    const reconFlow = new ReconectionFlow({
                        ctx,
                        state,
                        provider,
                        maxAttempts: 3,
                        onSuccess: async (newData) => {
                            // Derivar al flujo conversacional usando gotoFlow
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
                            data.linkWS = `https://wa.me/${ctx.from.replace(/[^0-9]/g, '')}`;
                            await addToSheet(data);
                        }
                    });
                    return await reconFlow.start();
                    // No cerrar el hilo aquí, dejar abierto para que el usuario pueda responder
                } else if (tipo === 'SI_RESUMEN') {
                    // Solo envía resumen al grupo ws y sheets, no envia msj de cierre
                    console.log('SI_RESUMEN: Solo se envía resumen al grupo y sheets.');
                    data.linkWS = `https://wa.me/${ctx.from.replace(/[^0-9]/g, '')}`;
                    {
                        const resumenConLink = `${resumen}\n\n🔗 [Chat del usuario](${data.linkWS})`;
                        try {
                            await provider.sendText(ID_GRUPO_RESUMEN, resumenConLink);
                            console.log(`✅ SI_RESUMEN: Resumen enviado a ${ID_GRUPO_RESUMEN} con enlace de WhatsApp`);
                        } catch (err) {
                            console.error(`❌ SI_RESUMEN: No se pudo enviar el resumen al grupo ${ID_GRUPO_RESUMEN}:`, err?.message || err);
                        }
                    }
                    await addToSheet(data);
                    return; // No enviar mensaje de cierre
                } else {
                    // Si aparece otro tipo, se procede como SI_RESUMEN por defecto
                    console.log('Tipo desconocido, procesando como SI_RESUMEN por defecto.');
                    data.linkWS = `https://wa.me/${ctx.from.replace(/[^0-9]/g, '')}`;
                    {
                        const resumenConLink = `${resumen}\n\n🔗 [Chat del usuario](${data.linkWS})`;
                        try {
                            await provider.sendText(ID_GRUPO_RESUMEN, resumenConLink);
                            console.log(`✅ DEFAULT: Resumen enviado a ${ID_GRUPO_RESUMEN} con enlace de WhatsApp`);
                        } catch (err) {
                            console.error(`❌ DEFAULT: No se pudo enviar el resumen al grupo ${ID_GRUPO_RESUMEN}:`, err?.message || err);
                        }
                    }
                    await addToSheet(data);
                    return; // No enviar mensaje de cierre
                }
            } catch (error) {
                // Captura errores generales del flujo
                console.error("Error al obtener el resumen de OpenAI:", error);
        return endFlow(); //("BNI, cambiando la forma en que el mundo hace negocios\nGracias por su contacto.");
    }
});

export { idleFlow };