
import { createClient } from "@supabase/supabase-js";
import { EventEmitter } from "events";
import dotenv from "dotenv";

dotenv.config();


const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

// Emitter para notificar cambios en tiempo real a otros módulos (como el de WebSockets)
export const historyEvents = new EventEmitter();

// Identificador único para este bot específico
const PROJECT_ID = process.env.RAILWAY_PROJECT_ID || "default_project";

export interface Chat {
    id: string;
    project_id: string; // Nuevo campo para multitenancy
    type: 'whatsapp' | 'webchat';
    name: string | null;
    bot_enabled: boolean;
    last_message_at: string;
    metadata: any;
}

export interface Message {
    id?: string;
    chat_id: string;
    project_id: string; // También lo añadimos a mensajes para facilitar limpiezas o auditorias
    role: 'user' | 'assistant' | 'system';
    content: string;
    type: 'text' | 'image' | 'audio' | 'video' | 'location' | 'document';
    created_at?: string;
}


export class HistoryHandler {

    static async initDatabase() {
        if (!supabase) return;

        console.log('🔍 [HistoryHandler] Verificando tablas de historial...');

        const tables = [
            {
                name: 'chats',
                sql: `CREATE TABLE IF NOT EXISTS chats (
                    id TEXT,
                    project_id TEXT,
                    type TEXT NOT NULL,
                    name TEXT,
                    bot_enabled BOOLEAN DEFAULT true,
                    last_message_at TIMESTAMPTZ DEFAULT NOW(),
                    metadata JSONB DEFAULT '{}'::jsonb,
                    PRIMARY KEY (id, project_id)
                );`
            },
            {
                name: 'messages',
                sql: `CREATE TABLE IF NOT EXISTS messages (
                    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
                    chat_id TEXT,
                    project_id TEXT,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    type TEXT DEFAULT 'text',
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    FOREIGN KEY (chat_id, project_id) REFERENCES chats(id, project_id)
                );`
            }
        ];

        for (const table of tables) {
            try {
                // Verificar si la tabla existe
                const { error: checkError } = await supabase.from(table.name).select('*').limit(1);
                
                if (checkError && (checkError.code === '42P01' || checkError.code === 'PGRST204' || checkError.code === 'PGRST205')) {
                    console.log(`⚠️ Tabla '${table.name}' no encontrada. Creándola...`);
                    const { error: rpcError } = await supabase.rpc('exec_sql', { query: table.sql });
                    
                    if (rpcError) {
                        console.error(`❌ Error al crear tabla '${table.name}':`, rpcError.message);
                        if (rpcError.message.includes('function') && rpcError.message.includes('does not exist')) {
                            console.error(`💡 TIP: Debes crear la función 'exec_sql' en el SQL Editor de Supabase.`);
                        }
                    } else {
                        console.log(`✅ Tabla '${table.name}' creada exitosamente.`);
                    }
                } else if (checkError && checkError.code !== '42703') {
                    // Si el error es 42703 (columna falta) lo ignoramos aquí porque lo trataremos abajo
                    console.error(`❌ Error verificando tabla '${table.name}':`, checkError.message);
                } else {
                    // Verificar si falta la columna project_id (Migración)
                    const { error: columnError } = await supabase.from(table.name).select('project_id').limit(1);
                    if (columnError && columnError.code === '42703') {
                         console.log(`🔧 Actualizando tabla '${table.name}' para incluir project_id...`);
                         const alterSql = table.name === 'chats' 
                            ? `ALTER TABLE chats ADD COLUMN IF NOT EXISTS project_id TEXT DEFAULT 'default_project'; 
                               DO $$ 
                               BEGIN 
                                 IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name='chats_pkey') THEN
                                   ALTER TABLE chats DROP CONSTRAINT chats_pkey; 
                                 END IF;
                               END $$;
                               ALTER TABLE chats ADD PRIMARY KEY (id, project_id);`
                            : `ALTER TABLE messages ADD COLUMN IF NOT EXISTS project_id TEXT DEFAULT 'default_project';`;
                         
                         const { error: alterError } = await supabase.rpc('exec_sql', { query: alterSql });
                         if (alterError) {
                             console.error(`❌ Error en migración de '${table.name}':`, alterError.message);
                         } else {
                             console.log(`✅ Tabla '${table.name}' migrada a multitenancy.`);
                         }
                    }
                    console.log(`✅ Tabla '${table.name}' verificada.`);
                }
            } catch (fatalErr) {
                console.error(`❌ Error fatal inicializando tabla '${table.name}':`, fatalErr);
            }
        }
    }
    
    /**
     * Obtiene o crea un registro de chat
     */
    static async getOrCreateChat(chatId: string, type: 'whatsapp' | 'webchat', name: string | null = null): Promise<Chat | null> {
        try {
            const { data, error } = await supabase
                .from('chats')
                .select('*')
                .eq('id', chatId)
                .eq('project_id', PROJECT_ID)
                .maybeSingle();

            if (!data) {
                const { data: newData, error: insertError } = await supabase
                    .from('chats')
                    .insert({
                        id: chatId,
                        project_id: PROJECT_ID,
                        type,
                        name,
                        bot_enabled: true,
                        last_message_at: new Date().toISOString()
                    })
                    .select()
                    .single();
                
                if (insertError) throw insertError;
                return newData;
            }

            if (error) throw error;

            // Actualizar nombre si es null y ahora tenemos uno
            if (name && !data.name) {
                await supabase.from('chats').update({ name }).eq('id', chatId).eq('project_id', PROJECT_ID);
            }

            return data;
        } catch (err) {
            console.error('[HistoryHandler] Error en getOrCreateChat:', err);
            return null;
        }
    }

    /**
     * Guarda un mensaje en la base de datos
     */
    static async saveMessage(chatId: string, role: 'user' | 'assistant' | 'system', content: string, type: string = 'text', contactName: string | null = null) {
        try {
            // Asegurar que el chat existe
            await this.getOrCreateChat(chatId, chatId.includes('@') ? 'whatsapp' : 'webchat', contactName);

            const { error } = await supabase
                .from('messages')
                .insert({
                    chat_id: chatId,
                    project_id: PROJECT_ID,
                    role,
                    content,
                    type,
                    created_at: new Date().toISOString()
                });

            if (error) throw error;

            // Actualizar timestamp del último mensaje en el chat
            await supabase
                .from('chats')
                .update({ last_message_at: new Date().toISOString() })
                .eq('id', chatId)
                .eq('project_id', PROJECT_ID);

            // Emitir evento para WebSockets
            historyEvents.emit('new_message', { chatId, role, content, type });

        } catch (err) {
            console.error('[HistoryHandler] Error en saveMessage:', err);
        }
    }

    /**
     * Verifica si el bot está habilitado para un usuario
     */
    static async isBotEnabled(chatId: string): Promise<boolean> {
        try {
            const { data, error } = await supabase
                .from('chats')
                .select('bot_enabled')
                .eq('id', chatId)
                .eq('project_id', PROJECT_ID)
                .maybeSingle();

            if (error) throw error;
            return data ? data.bot_enabled : true;
        } catch (err) {
            console.error('[HistoryHandler] Error en isBotEnabled:', err);
            return true;
        }
    }

    /**
     * Cambia el estado del bot (Intervención humana)
     */
    static async toggleBot(chatId: string, enabled: boolean) {
        try {
            const { error } = await supabase
                .from('chats')
                .update({ bot_enabled: enabled })
                .eq('id', chatId)
                .eq('project_id', PROJECT_ID);
            
            if (error) throw error;
            
            // Emitir evento para WebSockets
            historyEvents.emit('bot_toggled', { chatId, bot_enabled: enabled });

            return { success: true };
        } catch (err) {
            console.error('[HistoryHandler] Error en toggleBot:', err);
            return { success: false, error: err.message };
        }
    }

    /**
     * Lista todos los chats activos
     */
    static async listChats() {
        try {
            const { data, error } = await supabase
                .from('chats')
                .select('*')
                .eq('project_id', PROJECT_ID)
                .order('last_message_at', { ascending: false });
            
            if (error) throw error;
            return data;
        } catch (err) {
            console.error('[HistoryHandler] Error en listChats:', err);
            return [];
        }
    }

    /**
     * Obtiene los mensajes de un chat específico
     */
    static async getMessages(chatId: string, limit: number = 50) {
        try {
            const { data, error } = await supabase
                .from('messages')
                .select('*')
                .eq('chat_id', chatId)
                .eq('project_id', PROJECT_ID)
                .order('created_at', { ascending: true })
                .limit(limit);
            
            if (error) throw error;
            return data;
        } catch (err) {
            console.error('[HistoryHandler] Error en getMessages:', err);
            return [];
        }
    }
}

// Inicializar base de datos al cargar el modulo
HistoryHandler.initDatabase();
