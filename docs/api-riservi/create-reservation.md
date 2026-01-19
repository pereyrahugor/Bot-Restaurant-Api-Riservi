# Crear Reserva 📝

Este módulo gestiona la creación de nuevas reservaciones en el sistema de Riservi.

## Definición Técnica
* **Método**: `POST`
* **Ruta Relativa**: `/bookings/`
* **Función Interna**: `createReservation(reserva: any, apiKey?: string)`

## Parámetros de Entrada (Cuerpo de la Petición)

| Parámetro | Tipo | Descripción | Requerido |
| :--- | :--- | :--- | :--- |
| `date` | `string` | Fecha y hora en formato `YYYY-MM-DD HH:mm`. | Sí |
| `partySize` | `number` | Cantidad de personas para la reserva. | Sí |
| `reserveName` | `string` | Nombre de quien realiza la reserva. | Sí |
| `reserveLastname` | `string` | Apellido de quien realiza la reserva. | Sí |
| `reserveEmail` | `string` | Correo electrónico de contacto. | Sí |
| `reservePhone` | `string` | Teléfono de contacto. | Sí |
| `notes` | `string` | Notas adicionales para el restaurante. | No |
| `eventSourceId` | `number` | ID del canal de origen (Default: `12`). | No |

## Ejemplo de Llamada

```json
{
  "date": "2024-12-24 20:30",
  "partySize": 4,
  "reserveName": "Juan",
  "reserveLastname": "Pérez",
  "reserveEmail": "juan.perez@example.com",
  "reservePhone": "+5491100000000",
  "notes": "Mesa cerca de la ventana",
  "eventSourceId": 12
}
```

## Respuesta / Retorno

Retorna un objeto con los detalles de la reserva creada y un `reservaId`.

```json
{
  "success": true,
  "reservaId": "BK-987654321",
  "response": {
    "bookingId": "BK-987654321",
    "status": "confirmed",
    "diner": {
      "firstName": "Juan",
      "lastName": "Pérez",
      "email": "juan.perez@example.com"
    }
  }
}
```

### Detalle de Campos de Respuesta
| Campo | Tipo | Descripción |
| :--- | :--- | :--- |
| `success` | `boolean` | Indica si la operación fue exitosa. |
| `reservaId` | `string` | Identificador único de la reserva generado por Riservi. |
| `response` | `object` | Objeto con la respuesta completa de la API de Riservi. |

## Gestión de Errores

| Código | Descripción |
| :--- | :--- |
| `timeout` | La petición excedió el tiempo máximo de espera (120s). |
| `Error: Faltan datos` | No se incluyó el campo `partySize`. |
| `API Error` | Error retornado directamente por Riservi (ej: horario no disponible). |

---
**Ver También**:
- [Consultar Disponibilidad](check-availability.md)
- [Cancelar Reserva](cancel-reservation.md)
