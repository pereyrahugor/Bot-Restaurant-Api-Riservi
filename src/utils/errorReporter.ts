import { EVENTS, ProviderClass } from "@builderbot/bot";

class ErrorReporter {
    private provider: ProviderClass;
    private groupId: string;

    constructor(provider: ProviderClass, groupId: string) {
        this.provider = provider;
        this.groupId = groupId;
    }

    async reportError(error: Error, userId: string, userLink: string) {
        const errorMessage = `⚠ pregunta que NO supe responder ⚠\n` +
            `No supe: ${error.message}\n` +
            `whatsappLink = ${userLink}`;

        try {
            await this.provider.sendMessage(this.groupId, errorMessage, {});
        } catch (sendError) {
            console.error("Error al enviar el mensaje de error al grupo:", sendError);
        }
    }
}

export { ErrorReporter };