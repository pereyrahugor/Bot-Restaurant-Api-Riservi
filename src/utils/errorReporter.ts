import { sendToGroup } from "./groupSender";

class ErrorReporter {
    private groupId: string;

    constructor(provider: any, groupId: string) {
        this.groupId = groupId;
    }

    async reportError(error: Error, userId: string, userLink: string) {
        const errorMessage = `⚠ pregunta que NO supe responder ⚠\n` +
            `No supe: ${error.message}\n` +
            `whatsappLink = ${userLink}`;

        try {
            await sendToGroup(this.groupId, errorMessage);
        } catch (sendError) {
            console.error("Error al enviar el mensaje de error al grupo:", sendError);
        }
    }
}

export { ErrorReporter };