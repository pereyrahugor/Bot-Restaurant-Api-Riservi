# Documentación Técnica: Bot Restaurant API Riservi 🍽️

Bienvenido a la documentación técnica premium del **Bot de Reservas para Restaurantes integrado con Riservi**. Esta guía proporciona detalles exhaustivos sobre la arquitectura, las integraciones de API y los flujos de conversación del bot.

## 🚀 Introducción
Este proyecto es un asistente inteligente basado en **BuilderBot** que permite gestionar reservas de restaurantes de forma automatizada a través de WhatsApp y WebChat. Utiliza la potencia de **OpenAI** para procesar lenguaje natural e integrarse directamente con la API de **Riservi**.

### 🛠️ Tecnologías Principales
- **Runtime**: Node.js / TypeScript
- **Bot Framework**: [BuilderBot](https://builderbot.app/)
- **Provider**: Baileys (WhatsApp)
- **IA**: OpenAI Assistants API
- **Base de Datos**: Supabase (para persistencia de sesiones)
- **API de Reservas**: Riservi API
- **Hosting**: Railway

## 🔗 URL Base y Entornos
- **Producción**: Las peticiones de la API de Riservi se dirigen a `https://partners.riservi.com/api/v1/restaurants`.
- **Bot Dashboard**: El bot expone un dashboard administrativo en la raíz del dominio donde está desplegado.

## 📋 Guía Rápida de Inicio
1. **Configuración de Variables**: Copia el archivo `.env.example` (o crea un `.env`) con las credenciales de OpenAI, Riservi y Supabase.
2. **Instalación**: `pnpm install` o `npm install`.
3. **Ejecución**: `npm run dev`.
4. **Vinculación**: Escanea el código QR generado en el dashboard (`/`) con WhatsApp.

---
> **Nota**: Esta documentación está diseñada para desarrolladores y administradores del sistema. Si necesitas soporte técnico adicional, contacta al equipo de DusckCodes.
