# Obtener Reserva 📖

Consulta la información detallada de una reservación existente mediante su Identificador Único.

## Definición Técnica
* **Método**: `GET`
* **Ruta Relativa**: `/bookings/{id}`
* **Función Interna**: `getReservationById(id: string)`

## Parámetros de Path

| Parámetro | Tipo | Descripción | Requerido |
| :--- | :--- | :--- | :--- |
| `id` | `string` | ID de la reserva generado por Riservi. | Sí |

## Ejemplo de Llamada

```javascript
const res = await getReservationById("BK-987654321");
```

## Respuesta / Retorno

```json
{
  "success": true,
  "response": {
    "id": "BK-987654321",
    "date": "2024-12-24 20:30",
    "partySize": 4,
    "status": "confirmed",
    "diner": {
      "firstName": "Juan",
      "lastName": "Pérez",
      "phone": {
        "e164Format": "+5491100000000"
      }
    },
    "notes": "Mesa cerca de la ventana"
  }
}
```

### Detalle de Campos de Respuesta
| Campo | Tipo | Descripción |
| :--- | :--- | :--- |
| `id` | `string` | Identificador de la reserva. |
| `status` | `string` | Estado actual (`confirmed`, `cancelled`, `pending`). |
| `diner` | `object` | Información del cliente (comensal). |

## Gestión de Errores

| Código/Error | Descripción |
| :--- | :--- |
| 404 Not Found | La reserva con el ID proporcionado no existe en Riservi. |
| 401 Unauthorized | El TOKEN de API es inválido o ha expirado. |

---
**Ver También**:
- [Actualizar Reserva](update-reservation.md)
- [Cancelar Reserva](cancel-reservation.md)
