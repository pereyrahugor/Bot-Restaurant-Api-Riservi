# Actualizar Reserva 🔄

Permite modificar la fecha, hora o cantidad de personas de una reservación existente.

## Definición Técnica
* **Método**: `PUT`
* **Ruta Relativa**: `/bookings/{id}`
* **Función Interna**: `updateReservationById(id, newDate, newPartySize)`

## Parámetros de Entrada (Cuerpo de la Petición)

| Parámetro | Tipo | Descripción | Requerido |
| :--- | :--- | :--- | :--- |
| `date` | `string` | Nueva fecha y hora (`YYYY-MM-DD HH:mm`). | Sí |
| `partySize` | `number` | Nueva cantidad de personas. | Sí |
| `reservePhone` | `string` | Teléfono del cliente (obtenido de la reserva previa). | Sí |

> **Nota**: Internamente, esta función primero realiza un `GET` para recuperar los datos actuales de la reserva y mantener consistencia en campos como `reservePhone` y `notes`.

## Ejemplo de Llamada

```javascript
const updated = await updateReservationById("BK-987654321", "2024-12-25 21:00", 6);
```

## Respuesta / Retorno

```json
{
  "success": true,
  "response": {
    "bookingId": "BK-987654321",
    "date": "2024-12-25 21:00",
    "partySize": 6,
    "status": "modified"
  }
}
```

## Gestión de Errores

| Error | Descripción |
| :--- | :--- |
| `No se pudo obtener la reserva` | El ID no es válido o la API falló al consultar la reserva actual. |
| `Fecha debe ser posterior` | Se intentó mover la reserva a una fecha/hora pasada. |
| `API Error` | Errores de validación de Riservi (ej: no hay lugar para la nueva cantidad). |

---
**Ver También**:
- [Obtener Reserva](get-reservation.md)
