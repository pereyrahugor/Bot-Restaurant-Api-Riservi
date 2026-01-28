// src/utils/JsonBlockFinder.ts

export class JsonBlockFinder {
    static buscarBloquesJSONEnTexto(texto: string): any | null {
        // 1. Buscar bloques entre etiquetas [JSON-RESERVA], [JSON-DISPONIBLE], [JSON-MODIFICAR], [JSON-CANCELAR]
        const etiquetas = [
            { tag: 'JSON-RESERVA', type: '#RESERVA#' },
            { tag: 'JSON-DISPONIBLE', type: '#DISPONIBLE#' },
            { tag: 'JSON-MODIFICAR', type: '#MODIFICAR#' },
            { tag: 'JSON-CANCELAR', type: '#CANCELAR#' },
            { tag: 'JSON-CONFIRMAR', type: '#CONFIRMAR#' }
        ];
        for (const { tag, type } of etiquetas) {
            // Corregido: buscar etiquetas literales [JSON-RESERVA], etc.
                const regex = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[/${tag}\\]`, 'g');
            let match;
            while ((match = regex.exec(texto)) !== null) {
                try {
                    const parsed = JSON.parse(match[1]);
                    if (parsed.type === type) {
                        return parsed;
                    }
                } catch (e) {
                    // No es JSON válido, sigue buscando
                }
            }
        }
        // 2. Buscar bloques JSON sueltos en el texto
        const bloques = [...texto.matchAll(/\{[\s\S]*?\}/g)].map(m => m[0]);
        for (const block of bloques) {
            try {
                const parsed = JSON.parse(block);
                if (["#RESERVA#", "#DISPONIBLE#", "#MODIFICAR#", "#CANCELAR#", "#CONFIRMAR#"].includes(parsed.type)) {
                    return parsed;
                }
            } catch (e) {
                // No es JSON válido, sigue buscando
            }
        }
        return null;
    }

    static buscarBloquesJSONProfundo(obj: any): any | null {
        if (!obj) return null;
        if (typeof obj === 'string') {
            return JsonBlockFinder.buscarBloquesJSONEnTexto(obj);
        }
        if (typeof obj === 'object') {
            for (const key of Object.keys(obj)) {
                const encontrado = JsonBlockFinder.buscarBloquesJSONProfundo(obj[key]);
                if (encontrado) return encontrado;
            }
        }
        return null;
    }
}
