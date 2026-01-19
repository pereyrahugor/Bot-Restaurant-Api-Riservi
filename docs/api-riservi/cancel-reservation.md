# Cancelar Reserva 🚫

Marca una reservación existente como cancelada en el sistema de Riservi.

## Definición Técnica
* **Método**: `PATCH`
* **Ruta Relativa**: `/bookings/{id}/cancel`
* **Función Interna**: `cancelReservationById(id: string)`

## Parámetros de Path

| Parámetro | Tipo | Descripción | Requerido |
| :--- | :--- | :--- | :--- |
| `id` | `string` | ID único de la reserva a cancelar. | Sí |

## Ejemplo de Llamada

```javascript
const result = await cancelReservationById("BK-987654321");
```

## Respuesta / Retorno

```json
{
  "success": true,
  "message": "La reserva ha sido cancelada satisfactoriamente.",
  "response": {
    "bookingId": "BK-987654321",
    "status": "cancelled"
  }
}
```

## Gestión de Errores

| Caso | Comportamiento |
| :--- | :--- |
| Reserva ya cancelada | La API puede retornar un éxito redundante o un error de estado. |
| ID incorrecto | Retorna error 404. |

---
**Ver También**:
- [Crear Reserva](create-reservation.md)
