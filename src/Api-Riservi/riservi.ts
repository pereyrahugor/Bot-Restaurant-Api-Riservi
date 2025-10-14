/**
 * Cancela una reserva por su ID.
 * @param id ID de la reserva
 * @param apiKey API Key opcional
 * @returns Respuesta de la API
 */

/**
 * Modifica una reserva existente por ID.
 * @param id ID de la reserva
 * @param newDate Nueva fecha (string, formato 'YYYY-MM-DD HH:mm')
 * @param newPartySize Nuevo número de personas
 * @param apiKey API Key opcional
 * @returns Respuesta de la API
 */

/**
 * Busca una reserva por su ID.
 * @param id ID de la reserva
 * @param apiKey API Key opcional
 * @returns Datos de la reserva o error
 */

import axios from "axios";
import moment from "moment";
import "dotenv/config";

//const BASE_URL = "https://partnersdev.riservi.com/api/v1/restaurants";
const BASE_URL = "https://partners.riservi.com/api/v1/restaurants";
const API_KEY = process.env.RESERVI_API_KEY ?? "";

export const createReservation = async (reserva: any, apiKey?: string) => {
    const keyToUse = apiKey || API_KEY;

    // Validar que el número de personas esté presente (solo partySize, sin ambigüedad)
    if (!('partySize' in reserva) || typeof reserva.partySize !== 'number' || reserva.partySize <= 0) {
        throw new Error("Faltan los siguientes datos para la reserva: partySize");
    }

    // Validar y corregir la fecha para el endpoint (siempre 'YYYY-MM-DD HH:mm')
    let reservaMoment;
    let now;
    if (reserva.date) {
        reservaMoment = moment(reserva.date, [moment.ISO_8601, "YYYY-MM-DD HH:mm", "YYYY-MM-DDTHH:mm"]);
        // Si el año es menor al actual, lo corrige automáticamente al año vigente
        const vigente = moment().year();
        if (reservaMoment.isValid() && reservaMoment.year() < vigente) {
            reservaMoment.year(vigente);
        }
        // Validación de fecha futura eliminada (ya validada en el asistente)
    }
    // Mapear los campos del bot/asistente al formato esperado por la API
    // Solo incluir campos con valor, y mover preferredArea a notes si es "No fumadores"
    const payload: any = {};
    if (reservaMoment && reservaMoment.isValid()) {
        payload.date = reservaMoment.format("YYYY-MM-DD HH:mm");
    } else if (reserva.date) {
        payload.date = reserva.date;
    }
    if (typeof reserva.partySize === 'number' && reserva.partySize > 0) payload.partySize = reserva.partySize;
    if (reserva.reserveName) payload.reserveName = reserva.reserveName;
    if (reserva.reserveLastname) payload.reserveLastname = reserva.reserveLastname;
    if (reserva.reserveEmail) payload.reserveEmail = reserva.reserveEmail;
    if (reserva.reservePhone) payload.reservePhone = reserva.reservePhone;
    if (reserva.reserveBirthday) payload.reserveBirthday = reserva.reserveBirthday;
    if (reserva.preferredLang) payload.preferredLang = reserva.preferredLang;
    if (reserva.notes) payload.notes = reserva.notes;
    // Si preferredArea es "No fumadores" o similar, agregarlo a notes
    if (reserva.preferredArea && reserva.preferredArea.toLowerCase().includes("no fumadores")) {
        payload.notes = (payload.notes ? payload.notes + ' ' : '') + reserva.preferredArea;
    } else if (reserva.preferredArea) {
        payload.preferredArea = reserva.preferredArea;
    }
    if (reserva.utmParams) payload.utmParams = reserva.utmParams;
   // if (typeof reserva.sendEmailToDiner === 'boolean') payload.sendEmailToDiner = reserva.sendEmailToDiner;
    if (reserva.promoCode) payload.promoCode = reserva.promoCode;
    if (reserva.eventTypeId) payload.eventTypeId = reserva.eventTypeId;
    if (reserva.eventSourceId) payload.eventSourceId = reserva.eventSourceId;
    if (reserva.tags) payload.tags = reserva.tags;
    // Copiar todos los campos adicionales de la variante sugerida (por ejemplo, shift, slotId, turno, etc.)
    // Esto asegura que si la variante sugerida tiene campos especiales, se envíen igual a la reserva
    const extraKeys = [
        'shift', 'slotId', 'turno', 'turn', 'availabilityId', 'tableId', 'area', 'service', 'serviceId', 'time', 'hour', 'dateTime', 'bookingToken'
    ];
    for (const key of extraKeys) {
        if (reserva[key] !== undefined && payload[key] === undefined) {
            payload[key] = reserva[key];
        }
    }
    // LOG de entrada para createReservation
    console.log('[Riservi API] createReservation payload:', JSON.stringify(payload, null, 2));

    try {
        const response = await axios.post(
            `${BASE_URL}/bookings/`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${keyToUse}`,
                    "Content-Type": "application/json"
                }
            }
        );
        // Único log: respuesta de la API
        console.log("[Riservi API] response.data:", JSON.stringify(response.data, null, 2));
        // Buscar un campo de id de reserva en la respuesta
        const data = response.data;
        let reservaId = data.id || data.bookingId || data.reservationId;
        if (!reservaId && data.response) {
            reservaId = data.response.id || data.response.bookingId || data.response.reservationId;
        }
        return { ...data, reservaId };
    } catch (error) {
        if (error.response) {
            return error.response.data; // <-- Devolver el error de la API para que el bot lo pueda mostrar/analizar
        } else {
            return { error: String(error) };
        }
    }
};

/**
 * Consulta la disponibilidad de una reserva para una fecha y cantidad de personas.
 * @param date Fecha y hora en formato "YYYY-MM-DD HH:mm"
 * @param people Cantidad de personas
 * @param apiKey API Key opcional
 * @returns { available: boolean, slots?: any, [otros atributos de la respuesta] }
 */
export const checkAvailability = async (date: string, people: number, apiKey?: string) => {
    const keyToUse = apiKey || API_KEY;
    const urlDate = encodeURIComponent(date);
    const url = `${BASE_URL}/availability/available-slots/${urlDate}/${people}`;
    // LOG de entrada para checkAvailability
    console.log('[Riservi API] checkAvailability params:', { date, people });
    try {
        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${keyToUse}`,
                "Content-Type": "application/json"
            }
        });
        return response.data;
    } catch (error) {
        if (error.response) {
            return error.response.data;
        } else {
            return { error: String(error) };
        }
    }
};

export const getReservationById = async (id: string, apiKey?: string) => {
    const keyToUse = apiKey || API_KEY;
    const url = `${BASE_URL}/bookings/${id}`;
    try {
        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${keyToUse}`,
                "Content-Type": "application/json"
            }
        });
        return response.data;
    } catch (error) {
        if (error.response) {
            return error.response.data;
        } else {
            return { error: String(error) };
        }
    }
};

export const updateReservationById = async (
    id: string,
    newDate: string,
    newPartySize: number,
    apiKey?: string
) => {
    const keyToUse = apiKey || API_KEY;
    // Obtener la reserva actual
    const current = await getReservationById(id, keyToUse);
    if (!current || !current.response) {
        throw new Error('No se pudo obtener la reserva para modificar.');
    }
    const reserva = current.response;
    // Preparar el payload para el PUT
    const momentDate = moment(newDate, [moment.ISO_8601, 'YYYY-MM-DD HH:mm', 'YYYY-MM-DDTHH:mm']);
    const vigente = moment().year();
    if (momentDate.isValid() && momentDate.year() < vigente) {
        momentDate.year(vigente);
    }
    if (!momentDate.isValid() || momentDate.isSameOrBefore(moment())) {
        throw new Error('La fecha de la reserva debe ser posterior a la fecha y hora actual.');
    }
    const payload: any = {
        date: momentDate.format('YYYY-MM-DD HH:mm'),
        partySize: newPartySize,
        reservePhone: reserva.diner?.phone?.e164Format || reserva.reservePhone,
        notes: reserva.eventNotes || reserva.notes,
        shift: reserva.shift,
        preferredArea: reserva.preferredArea,
        sendEmailToDiner: typeof reserva.sendEmailToDiner === 'boolean' ? reserva.sendEmailToDiner : true
    };
    // LOG de entrada para updateReservationById
    console.log('[Riservi API] updateReservationById params:', { id, newDate, newPartySize });
    console.log('[Riservi API] updateReservationById payload:', JSON.stringify(payload, null, 2));

    // Puedes agregar otros campos si son requeridos por la API
    const url = `${BASE_URL}/bookings/${id}`;
    try {
        const response = await axios.put(url, payload, {
            headers: {
                Authorization: `Bearer ${keyToUse}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    } catch (error) {
        if (error.response) {
            return error.response.data;
        } else {
            return { error: String(error) };
        }
    }
};

export const cancelReservationById = async (id: string, apiKey?: string) => {
    const keyToUse = apiKey || API_KEY;
    const url = `${BASE_URL}/bookings/${id}/cancel`;
    // LOG de entrada para cancelReservationById
    console.log('[Riservi API] cancelReservationById params:', { id });
    try {
        const response = await axios.patch(url, {}, {
            headers: {
                Authorization: `Bearer ${keyToUse}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    } catch (error) {
        if (error.response) {
            return error.response.data;
        } else {
            return { error: String(error) };
        }
    }
};

