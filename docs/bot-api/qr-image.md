# Imagen QR 📱

Endpoint que sirve la imagen actual del código QR de WhatsApp para el escaneo inicial.

## Definición Técnica
* **Método**: `GET`
* **Ruta**: `/qr.png`

## Comportamiento
- Al recibir una petición, el servidor busca el archivo `bot.qr.png` en el directorio raíz.
- Si el archivo existe, lo sirve con el encabezado `Content-Type: image/png`.
- Se aplican encabezados de `Cache-Control` (no-store, no-cache) para asegurar que el navegador siempre solicite el QR más reciente.

## Respuestas

| Estado | Descripción |
| :--- | :--- |
| `200 OK` | Retorna el stream de la imagen PNG. |
| `404 Not Found` | No hay un código QR generado actualmente (posiblemente la sesión ya esté activa). |

---
**Ver También**:
- [Dashboard Principal](dashboard.md)
