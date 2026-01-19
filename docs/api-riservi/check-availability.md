# Consultar Disponibilidad 🔍

Este endpoint permite verificar si hay mesas disponibles para una fecha y cantidad de personas específicas.

## Definición Técnica
* **Método**: `GET`
* **Ruta Relativa**: `/availability/available-slots/{date}/{people}`
* **Función Interna**: `checkAvailability(date: string, people: number)`

## Parámetros de Path

| Parámetro | Tipo | Descripción | Requerido |
| :--- | :--- | :--- | :--- |
| `date` | `string` | Fecha y hora en formato `YYYY-MM-DD HH:mm` (URL Encoded). | Sí |
| `people` | `number` | Cantidad de personas. | Sí |

## Ejemplo de Llamada

```javascript
// Ejemplo de llamada interna
const availability = await checkAvailability("2024-12-24 20:30", 4);
```

**URL de Ejemplo**: 
`GET https://partners.riservi.com/api/v1/restaurants/availability/available-slots/2024-12-24%2020%3A30/4`

## Respuesta / Retorno

```json
{
  "available": true,
  "slots": [
    {
      "time": "20:30",
      "available": true,
      "slotId": "slot_123"
    },
    {
      "time": "21:00",
      "available": true,
      "slotId": "slot_124"
    }
  ],
  "message": "Horarios disponibles encontrados."
}
```

### Detalle de Campos de Respuesta
| Campo | Tipo | Descripción |
| :--- | :--- | :--- |
| `available` | `boolean` | Indica si hay disponibilidad general para la fecha solicitada. |
| `slots` | `array` | Lista de horarios (slots) disponibles cercanos a la hora solicitada. |
| `message` | `string` | Mensaje descriptivo del estado de la búsqueda. |

## Gestión de Errores

| Caso | Comportamiento |
| :--- | :--- |
| Fecha Inválida | Retorna un error indicando formato incorrecto. |
| Sin Disponibilidad | `available` será `false` y `slots` puede estar vacío. |
| Error de Red | Retorna un objeto con el mensaje de error de Axios. |

---
**Ver También**:
- [Crear Reserva](create-reservation.md)
