// Ejemplo básico de lógica de asistente
export async function processUserMessage(msg: string): Promise<string> {
  // Aquí puedes conectar tu lógica real de asistente
  if (!msg || msg.trim() === "") return "Por favor, escribe un mensaje.";
  // Respuesta simulada
  return `Asistente: Recibí tu mensaje: "${msg}"`;
}