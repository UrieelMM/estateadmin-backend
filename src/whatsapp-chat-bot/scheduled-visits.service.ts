import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import * as QRCode from 'qrcode';
import axios from 'axios';
import { normalizeMexNumber } from './formatNumber';

/**
 * Representa la información mínima del residente que se vincula a la visita
 * para mantener trazabilidad y permitir auditoría posterior.
 */
export interface VisitResidentInfo {
  userId: string;
  email: string;
  departmentNumber: string;
  tower?: string | null;
  phoneNumber: string; // Teléfono normalizado del chat
  name?: string;
  lastName?: string;
}

/**
 * Resultado del parser de fechas en español.
 */
export interface ParsedDateTime {
  date: Date;
  /** Indica si el usuario solo proporcionó hora sin fecha (asumimos hoy / mismo día). */
  timeOnly: boolean;
  /** Si el input fue un rango "todo el día" se setea a true. */
  allDay?: boolean;
  /** Texto humano de cómo se interpretó (para mostrar al usuario). */
  humanLabel: string;
}

/**
 * Configuración de recurrencia para visitas que se repiten en el tiempo
 * (limpieza semanal, mantenimiento, maestros, etc).
 */
export interface VisitRecurrence {
  /** Días de la semana válidos. 0=domingo, 1=lunes, ..., 6=sábado. */
  daysOfWeek: number[];
  /** Hora de llegada diaria en formato 24h "HH:MM". */
  dailyArrivalTime: string;
  /** Hora de salida diaria en formato 24h "HH:MM". */
  dailyDepartureTime: string;
  /** Primer día válido de la serie (00:00). */
  startDate: Date;
  /** Último día válido de la serie (23:59:59). */
  endDate: Date;
  /** Zona horaria con la que se interpreta el horario diario. */
  timezone?: string;
}

export interface CreateScheduledVisitInput {
  clientId: string;
  condominiumId: string;
  condominiumName?: string;
  resident: VisitResidentInfo;
  visitorName: string;
  visitorVehicle?: { plates?: string; description?: string };
  /** 'single' = una sola ocurrencia. 'recurring' = serie. Default 'single'. */
  visitType?: 'single' | 'recurring';
  /** Solo para visitType='single'. */
  arrivalAt?: Date;
  departureAt?: Date;
  /** Solo para visitType='recurring'. */
  recurrence?: VisitRecurrence;
  /** Etiquetas humanas para mostrar al usuario y guardar en Firestore. */
  arrivalLabel: string;
  departureLabel: string;
}

export interface CreateScheduledVisitResult {
  visitId: string;
  qrId: string;
  accessToken: string;
  qrImageUrl: string;
  qrPayload: string;
}

const VISITS_SUBCOLLECTION = 'scheduledVisits';
// Zona horaria por defecto. Si en el futuro el condominio tiene su propia tz,
// podríamos leerla del documento del condominio.
const DEFAULT_TIMEZONE = 'America/Mexico_City';
// Periodo de gracia agregado a la hora de salida antes de expirar realmente.
// Cubre demoras razonables en la salida del visitante.
const GRACE_MINUTES_AFTER_DEPARTURE = 120;
// Máximo número de días en el futuro para programar una visita.
const MAX_DAYS_IN_FUTURE = 30;

@Injectable()
export class ScheduledVisitsService implements OnModuleInit {
  private readonly logger = new Logger(ScheduledVisitsService.name);
  private firestore: admin.firestore.Firestore;

  onModuleInit() {
    this.firestore = admin.firestore();
    this.logger.log('ScheduledVisitsService inicializado.');
  }

  // =========================================================================
  // Parser de fecha y hora en español
  // =========================================================================

  /**
   * Parsea expresiones en español como:
   *  - "hoy 4pm"
   *  - "hoy a las 3:30pm"
   *  - "mañana 10am"
   *  - "sábado 18:00"
   *  - "27/04 14:30"
   *  - "5pm" (solo hora → hoy)
   *  - "todo el día sábado" (allDay)
   *
   * Devuelve null si no logra parsear.
   * `now` permite inyectar la fecha actual (útil para tests).
   */
  parseSpanishDateTime(text: string, now: Date = new Date()): ParsedDateTime | null {
    if (!text) return null;
    const cleaned = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Caso "todo el día <día>"
    const allDayMatch =
      /(todo el dia|todo eldia|todo el día)\s*(hoy|manana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)?/i.exec(
        cleaned,
      );
    if (allDayMatch) {
      const targetDay = allDayMatch[2] || 'hoy';
      const baseDate = this.resolveDayKeyword(targetDay, now);
      if (!baseDate) return null;
      const start = this.setTime(baseDate, 0, 0);
      return {
        date: start,
        timeOnly: false,
        allDay: true,
        humanLabel: `${this.formatHumanDate(start)} (todo el día)`,
      };
    }

    // Detectar fecha numérica DD/MM o DD-MM (con o sin año)
    const numericDateMatch =
      /(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?(?:\s+(?:a las\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i.exec(
        cleaned,
      );
    if (numericDateMatch) {
      const day = parseInt(numericDateMatch[1], 10);
      const month = parseInt(numericDateMatch[2], 10);
      let year = numericDateMatch[3]
        ? parseInt(numericDateMatch[3], 10)
        : now.getFullYear();
      if (year < 100) year += 2000; // soporte para "26"
      // Si no especificaron hora, no podemos programar la visita
      if (!numericDateMatch[4]) {
        return null;
      }
      const hour = parseInt(numericDateMatch[4], 10);
      const minute = numericDateMatch[5]
        ? parseInt(numericDateMatch[5], 10)
        : 0;
      const meridian = numericDateMatch[6] as 'am' | 'pm' | undefined;
      const adjHour = this.normalizeHour(hour, meridian);
      if (
        day < 1 ||
        day > 31 ||
        month < 1 ||
        month > 12 ||
        adjHour === null ||
        minute < 0 ||
        minute > 59
      ) {
        return null;
      }
      const date = new Date(year, month - 1, day, adjHour, minute, 0, 0);
      // Si la fecha ya pasó y no se especificó año, asumimos próximo año
      if (!numericDateMatch[3] && date.getTime() < now.getTime() - 60_000) {
        date.setFullYear(date.getFullYear() + 1);
      }
      return {
        date,
        timeOnly: false,
        humanLabel: this.formatHumanDateTime(date),
      };
    }

    // Detectar palabra clave de día + hora
    const dayKeywords = [
      'hoy',
      'manana',
      'pasado manana',
      'lunes',
      'martes',
      'miercoles',
      'jueves',
      'viernes',
      'sabado',
      'domingo',
    ];
    const dayKeyword = dayKeywords.find((d) => cleaned.includes(d));

    // Extraer hora si existe
    const timeMatch =
      /(?:a las\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.?m\.?|p\.?m\.?|hrs|h)?/i.exec(
        cleaned,
      );

    let baseDate: Date | null = null;
    if (dayKeyword) {
      baseDate = this.resolveDayKeyword(dayKeyword, now);
    } else if (timeMatch) {
      // Solo hora → hoy
      baseDate = new Date(now);
    }

    if (!baseDate) return null;
    if (!timeMatch) {
      // Solo día sin hora: rechazar — necesitamos hora exacta para programar
      return null;
    }

    const hour = parseInt(timeMatch[1], 10);
    const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    let meridianRaw = (timeMatch[3] || '').replace(/\./g, '').toLowerCase();
    let meridian: 'am' | 'pm' | undefined;
    if (meridianRaw === 'am') meridian = 'am';
    else if (meridianRaw === 'pm') meridian = 'pm';
    else meridian = undefined;

    const adjHour = this.normalizeHour(hour, meridian);
    if (adjHour === null || minute < 0 || minute > 59) return null;

    const result = this.setTime(baseDate, adjHour, minute);

    // Si fue "hoy" (o solo hora) y la hora ya pasó por más de 5 minutos,
    // *no* movemos al día siguiente: dejamos que el caller valide y devuelva
    // un mensaje claro al usuario. Programar visitas en el pasado no aplica.
    return {
      date: result,
      timeOnly: !dayKeyword,
      humanLabel: this.formatHumanDateTime(result),
    };
  }

  /**
   * Convierte una hora en formato 12h o 24h a 24h. Devuelve null si es inválida.
   */
  private normalizeHour(hour: number, meridian?: 'am' | 'pm'): number | null {
    if (hour < 0 || hour > 23) return null;
    if (meridian === 'am') {
      if (hour === 12) return 0;
      if (hour > 12) return null;
      return hour;
    }
    if (meridian === 'pm') {
      if (hour === 12) return 12;
      if (hour > 12) return null;
      return hour + 12;
    }
    // Sin meridiano, asumimos 24h
    return hour;
  }

  private resolveDayKeyword(keyword: string, now: Date): Date | null {
    const k = keyword.toLowerCase();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    if (k === 'hoy') return today;
    if (k === 'manana' || k === 'mañana') {
      const d = new Date(today);
      d.setDate(d.getDate() + 1);
      return d;
    }
    if (k === 'pasado manana' || k === 'pasado mañana') {
      const d = new Date(today);
      d.setDate(d.getDate() + 2);
      return d;
    }

    const weekdayMap: Record<string, number> = {
      domingo: 0,
      lunes: 1,
      martes: 2,
      miercoles: 3,
      jueves: 4,
      viernes: 5,
      sabado: 6,
    };
    if (weekdayMap[k] !== undefined) {
      const target = weekdayMap[k];
      const current = today.getDay();
      let diff = target - current;
      if (diff <= 0) diff += 7; // siempre el próximo
      const d = new Date(today);
      d.setDate(d.getDate() + diff);
      return d;
    }

    return null;
  }

  private setTime(date: Date, hour: number, minute: number): Date {
    const d = new Date(date);
    d.setHours(hour, minute, 0, 0);
    return d;
  }

  /**
   * Formatea una fecha como "Lun 27 Abr 2026, 3:00 PM" en español.
   */
  formatHumanDateTime(date: Date): string {
    const datePart = this.formatHumanDate(date);
    const timePart = date.toLocaleTimeString('es-MX', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: DEFAULT_TIMEZONE,
    });
    return `${datePart}, ${timePart}`;
  }

  formatHumanDate(date: Date): string {
    return date.toLocaleDateString('es-MX', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: DEFAULT_TIMEZONE,
    });
  }

  formatHumanTime(date: Date): string {
    return date.toLocaleTimeString('es-MX', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: DEFAULT_TIMEZONE,
    });
  }

  // =========================================================================
  // Parsers para recurrencia (días de la semana, duración relativa, hora HH:MM)
  // =========================================================================

  /**
   * Parsea una expresión de días de la semana en español. Acepta variantes:
   *  - "lunes y miércoles"
   *  - "lun, mié, vie"
   *  - "L M J"  → lunes, martes, jueves
   *  - "lunes a viernes"  → 1..5
   *  - "lunes-viernes"    → 1..5
   *  - "todos los días" / "todos" → 0..6
   *  - "fines de semana"  → 0,6
   *  - "entre semana"     → 1..5
   *
   * Devuelve un arreglo ordenado de días únicos (0=domingo … 6=sábado), o
   * null si no logra parsear.
   */
  parseDaysOfWeek(text: string): number[] | null {
    if (!text) return null;
    const cleaned = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) return null;

    // Casos completos
    if (
      /todos( los)?( dias)?/.test(cleaned) ||
      /^l\s*m\s*ma?\s*[mj]\s*v\s*s\s*d$/.test(cleaned)
    ) {
      return [0, 1, 2, 3, 4, 5, 6];
    }
    if (/fin(es)? de semana|fin de semana|sabado y domingo/.test(cleaned)) {
      return [0, 6];
    }
    if (/entre semana|dias habiles|dias laborales/.test(cleaned)) {
      return [1, 2, 3, 4, 5];
    }

    // Rango "X a Y" o "X-Y"
    const dayWordToNum: Record<string, number> = {
      domingo: 0, dom: 0, d: 0,
      lunes: 1, lun: 1, l: 1,
      martes: 2, mar: 2,
      miercoles: 3, mie: 3, mi: 3, x: 3,
      jueves: 4, jue: 4, j: 4,
      viernes: 5, vie: 5, v: 5,
      sabado: 6, sab: 6, s: 6,
    };

    const rangeMatch =
      /([a-z]+)\s*(?:a|-|hasta)\s*([a-z]+)/.exec(cleaned);
    if (rangeMatch) {
      const fromKey = rangeMatch[1];
      const toKey = rangeMatch[2];
      const from = dayWordToNum[fromKey];
      const to = dayWordToNum[toKey];
      if (from !== undefined && to !== undefined) {
        const result: number[] = [];
        // Soportar wrap-around (ej. "viernes a lunes")
        if (from <= to) {
          for (let i = from; i <= to; i++) result.push(i);
        } else {
          for (let i = from; i <= 6; i++) result.push(i);
          for (let i = 0; i <= to; i++) result.push(i);
        }
        return Array.from(new Set(result)).sort();
      }
    }

    // Lista por nombre / abreviatura / inicial — partimos por separadores
    const tokens = cleaned
      .replace(/\by\b/g, ',')
      .split(/[,;\/\.\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);

    const days: number[] = [];
    for (const token of tokens) {
      const n = dayWordToNum[token];
      if (n !== undefined) {
        days.push(n);
      } else {
        // Si hay un token desconocido, abortamos: el usuario probablemente
        // mezcló texto que no entendemos.
        return null;
      }
    }

    if (days.length === 0) return null;
    return Array.from(new Set(days)).sort();
  }

  /**
   * Convierte el arreglo de días a una etiqueta humana en español:
   * [1,3] → "lunes y miércoles"
   * [1,2,3,4,5] → "lunes a viernes"
   * [0,6] → "fines de semana"
   * [0..6] → "todos los días"
   */
  formatDaysOfWeek(days: number[]): string {
    if (!days || days.length === 0) return '';
    const sorted = Array.from(new Set(days)).sort();
    const setKey = sorted.join(',');
    if (setKey === '0,1,2,3,4,5,6') return 'todos los días';
    if (setKey === '1,2,3,4,5') return 'lunes a viernes';
    if (setKey === '0,6') return 'fines de semana';
    if (setKey === '1,2,3,4,5,6') return 'lunes a sábado';

    const names = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
    const labels = sorted.map((d) => names[d]);
    if (labels.length === 1) return labels[0];
    if (labels.length === 2) return `${labels[0]} y ${labels[1]}`;
    return labels.slice(0, -1).join(', ') + ' y ' + labels[labels.length - 1];
  }

  /**
   * Parsea una hora estilo "8am", "08:00", "18:30", "8:00 pm".
   * Devuelve "HH:MM" en formato 24h, o null si no logra parsear.
   */
  parseTimeOfDay(text: string): string | null {
    if (!text) return null;
    const cleaned = text.toLowerCase().trim();
    const match =
      /^(?:a las\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.?m\.?|p\.?m\.?|hrs|h)?$/i.exec(
        cleaned,
      );
    if (!match) return null;
    const hour = parseInt(match[1], 10);
    const minute = match[2] ? parseInt(match[2], 10) : 0;
    const meridianRaw = (match[3] || '').replace(/\./g, '').toLowerCase();
    let meridian: 'am' | 'pm' | undefined;
    if (meridianRaw === 'am') meridian = 'am';
    else if (meridianRaw === 'pm') meridian = 'pm';

    const adj = this.normalizeHour(hour, meridian);
    if (adj === null || minute < 0 || minute > 59) return null;
    return `${String(adj).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  /**
   * Parsea fecha de inicio de la serie. Acepta lo mismo que parseSpanishDateTime
   * pero también frases sin hora ("hoy", "mañana", "lunes 5 mayo", "5/5/2026").
   * Devuelve la fecha al inicio del día (00:00:00) en hora local.
   */
  parseStartDate(text: string, now: Date = new Date()): Date | null {
    const cleaned = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return null;

    // 1) Atajos de palabras clave
    const kw = ['hoy', 'manana', 'pasado manana'].find((k) => cleaned === k);
    if (kw) {
      return this.resolveDayKeyword(kw, now);
    }
    // Día de la semana solo
    const dayKw = [
      'lunes',
      'martes',
      'miercoles',
      'jueves',
      'viernes',
      'sabado',
      'domingo',
    ].find((d) => cleaned === d);
    if (dayKw) {
      return this.resolveDayKeyword(dayKw, now);
    }

    // 2) Formato numérico DD/MM[/YYYY]
    const numericMatch =
      /^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/.exec(cleaned);
    if (numericMatch) {
      const day = parseInt(numericMatch[1], 10);
      const month = parseInt(numericMatch[2], 10);
      let year = numericMatch[3]
        ? parseInt(numericMatch[3], 10)
        : now.getFullYear();
      if (year < 100) year += 2000;
      if (day < 1 || day > 31 || month < 1 || month > 12) return null;
      const date = new Date(year, month - 1, day, 0, 0, 0, 0);
      if (!numericMatch[3] && date.getTime() < now.getTime() - 60_000) {
        date.setFullYear(date.getFullYear() + 1);
      }
      return date;
    }

    // 3) Si trae hora, reusamos parseSpanishDateTime y le quitamos la hora
    const parsed = this.parseSpanishDateTime(text, now);
    if (parsed) {
      const d = new Date(parsed.date);
      d.setHours(0, 0, 0, 0);
      return d;
    }
    return null;
  }

  /**
   * Parsea una duración relativa para calcular endDate, ej:
   *  - "1 mes", "2 meses"
   *  - "3 semanas"
   *  - "30 dias"
   *  - "indefinido" / "siempre" → máximo permitido (6 meses)
   *  - "31/12/2026" → fecha absoluta
   *  - "hasta el viernes" → próxima ocurrencia de viernes (poco útil)
   *
   * Devuelve la fecha al final del día (23:59:59), o null si no logra parsear.
   */
  parseEndDate(text: string, startDate: Date): Date | null {
    const cleaned = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return null;

    // Indefinido → tope máximo
    if (
      /indefinido|siempre|sin fecha|hasta cuando sea|por tiempo indefinido/.test(
        cleaned,
      )
    ) {
      const max = new Date(startDate);
      max.setMonth(max.getMonth() + 6);
      max.setHours(23, 59, 59, 999);
      return max;
    }

    // "en X meses/semanas/días" o solo "X meses"
    const relMatch =
      /(?:en\s+|por\s+)?(\d+)\s*(meses?|semanas?|dias?|d|sem|m)\b/.exec(cleaned);
    if (relMatch) {
      const n = parseInt(relMatch[1], 10);
      const unitRaw = relMatch[2];
      const d = new Date(startDate);
      if (/mes|^m$/.test(unitRaw)) {
        d.setMonth(d.getMonth() + n);
      } else if (/sem/.test(unitRaw)) {
        d.setDate(d.getDate() + n * 7);
      } else {
        d.setDate(d.getDate() + n);
      }
      d.setHours(23, 59, 59, 999);
      return d;
    }

    // Fecha absoluta DD/MM[/YYYY]
    const numericMatch =
      /^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/.exec(cleaned);
    if (numericMatch) {
      const day = parseInt(numericMatch[1], 10);
      const month = parseInt(numericMatch[2], 10);
      let year = numericMatch[3]
        ? parseInt(numericMatch[3], 10)
        : startDate.getFullYear();
      if (year < 100) year += 2000;
      if (day < 1 || day > 31 || month < 1 || month > 12) return null;
      const d = new Date(year, month - 1, day, 23, 59, 59, 999);
      if (
        !numericMatch[3] &&
        d.getTime() < startDate.getTime()
      ) {
        d.setFullYear(d.getFullYear() + 1);
      }
      return d;
    }

    return null;
  }

  // =========================================================================
  // Validaciones de negocio para fechas de visita
  // =========================================================================

  /**
   * Valida que la fecha de llegada sea futura (con margen de 5 minutos para
   * tolerar drift) y dentro del rango permitido (hasta MAX_DAYS_IN_FUTURE).
   */
  validateArrival(
    date: Date,
    now: Date = new Date(),
  ): { ok: boolean; reason?: string } {
    const minAllowed = new Date(now.getTime() - 5 * 60_000);
    const maxAllowed = new Date(now);
    maxAllowed.setDate(maxAllowed.getDate() + MAX_DAYS_IN_FUTURE);
    if (date.getTime() < minAllowed.getTime()) {
      return {
        ok: false,
        reason:
          'La hora que indicaste ya pasó. Por favor escribe una fecha y hora futura, por ejemplo "hoy 4pm" o "mañana 10am".',
      };
    }
    if (date.getTime() > maxAllowed.getTime()) {
      return {
        ok: false,
        reason: `Solo puedes programar visitas hasta ${MAX_DAYS_IN_FUTURE} días en el futuro.`,
      };
    }
    return { ok: true };
  }

  /**
   * Valida que la salida sea posterior a la llegada y que la duración sea
   * razonable (entre 5 minutos y 24 horas).
   */
  validateDeparture(
    arrival: Date,
    departure: Date,
  ): { ok: boolean; reason?: string } {
    const diffMs = departure.getTime() - arrival.getTime();
    const fiveMinutes = 5 * 60_000;
    const oneDay = 24 * 60 * 60_000;
    if (diffMs < fiveMinutes) {
      return {
        ok: false,
        reason:
          'La hora de salida debe ser al menos 5 minutos después de la llegada.',
      };
    }
    if (diffMs > oneDay) {
      return {
        ok: false,
        reason:
          'La duración máxima permitida para una visita es de 24 horas. Si necesitas más, contacta a tu administrador.',
      };
    }
    return { ok: true };
  }

  /**
   * Valida la configuración de una visita recurrente.
   */
  validateRecurrence(
    recurrence: VisitRecurrence,
    now: Date = new Date(),
  ): { ok: boolean; reason?: string } {
    if (!recurrence.daysOfWeek || recurrence.daysOfWeek.length === 0) {
      return { ok: false, reason: 'Debes elegir al menos un día de la semana.' };
    }
    if (
      recurrence.daysOfWeek.some((d) => d < 0 || d > 6) ||
      recurrence.daysOfWeek.some(
        (d, i, arr) => arr.indexOf(d) !== i, // duplicados
      )
    ) {
      return { ok: false, reason: 'Días de la semana inválidos.' };
    }

    // Las horas deben estar en formato HH:MM y arrival < departure
    const arrParts = recurrence.dailyArrivalTime?.split(':');
    const depParts = recurrence.dailyDepartureTime?.split(':');
    if (!arrParts || !depParts || arrParts.length !== 2 || depParts.length !== 2) {
      return { ok: false, reason: 'Horario diario inválido.' };
    }
    const arrMin = +arrParts[0] * 60 + +arrParts[1];
    const depMin = +depParts[0] * 60 + +depParts[1];
    if (
      isNaN(arrMin) ||
      isNaN(depMin) ||
      arrMin < 0 ||
      arrMin > 24 * 60 ||
      depMin < 0 ||
      depMin > 24 * 60
    ) {
      return { ok: false, reason: 'Horario diario inválido.' };
    }
    if (depMin - arrMin < 5) {
      return {
        ok: false,
        reason: 'La hora de salida debe ser al menos 5 minutos después de la entrada.',
      };
    }

    // Fechas
    const startDay = new Date(recurrence.startDate);
    startDay.setHours(0, 0, 0, 0);
    const endDay = new Date(recurrence.endDate);
    endDay.setHours(23, 59, 59, 999);
    const today0 = new Date(now);
    today0.setHours(0, 0, 0, 0);

    if (startDay.getTime() < today0.getTime()) {
      return { ok: false, reason: 'La fecha de inicio no puede ser anterior a hoy.' };
    }
    if (endDay.getTime() < startDay.getTime()) {
      return { ok: false, reason: 'La fecha final debe ser posterior a la fecha de inicio.' };
    }

    // Tope máximo: 6 meses
    const maxEnd = new Date(startDay);
    maxEnd.setMonth(maxEnd.getMonth() + 6);
    if (endDay.getTime() > maxEnd.getTime()) {
      return {
        ok: false,
        reason:
          'La duración máxima de una visita recurrente es de 6 meses. Si necesitas más, contacta a tu administrador.',
      };
    }

    // Confirmar que el rango incluye al menos una ocurrencia válida
    const next = this.nextOccurrence(recurrence, now);
    if (!next) {
      return {
        ok: false,
        reason:
          'Con esos días y rango de fechas no hay ninguna ocurrencia futura. Revisa los días seleccionados.',
      };
    }
    return { ok: true };
  }

  /**
   * Calcula la próxima ocurrencia (objeto {arrival, departure}) de la serie
   * a partir de `from`. Devuelve null si no hay más ocurrencias.
   */
  nextOccurrence(
    recurrence: VisitRecurrence,
    from: Date = new Date(),
  ): { arrival: Date; departure: Date } | null {
    const startDay = new Date(recurrence.startDate);
    startDay.setHours(0, 0, 0, 0);
    const endDay = new Date(recurrence.endDate);
    endDay.setHours(23, 59, 59, 999);

    // Cursor empieza en max(from, startDay)
    const cursor = new Date(
      Math.max(from.getTime(), startDay.getTime()),
    );
    cursor.setSeconds(0, 0);

    const [aH, aM] = recurrence.dailyArrivalTime.split(':').map((n) => +n);
    const [dH, dM] = recurrence.dailyDepartureTime.split(':').map((n) => +n);

    // Buscamos hasta 366 días para cubrir todo el rango posible
    for (let i = 0; i < 400; i++) {
      const day = new Date(cursor);
      day.setDate(day.getDate() + i);
      if (day.getTime() > endDay.getTime()) return null;
      if (!recurrence.daysOfWeek.includes(day.getDay())) continue;

      const arrival = new Date(day);
      arrival.setHours(aH, aM, 0, 0);
      const departure = new Date(day);
      departure.setHours(dH, dM, 0, 0);

      // Si es hoy, descartamos si la hora de salida ya pasó
      if (i === 0 && departure.getTime() <= from.getTime()) continue;

      return { arrival, departure };
    }
    return null;
  }

  /**
   * Verifica si una fecha "now" cae dentro de una ocurrencia válida de la serie
   * (día permitido + dentro de la ventana horaria).
   */
  isWithinRecurrenceWindow(
    recurrence: VisitRecurrence,
    now: Date = new Date(),
  ): boolean {
    const startDay = new Date(recurrence.startDate);
    startDay.setHours(0, 0, 0, 0);
    const endDay = new Date(recurrence.endDate);
    endDay.setHours(23, 59, 59, 999);
    if (now.getTime() < startDay.getTime()) return false;
    if (now.getTime() > endDay.getTime()) return false;
    if (!recurrence.daysOfWeek.includes(now.getDay())) return false;

    const [aH, aM] = recurrence.dailyArrivalTime.split(':').map((n) => +n);
    const [dH, dM] = recurrence.dailyDepartureTime.split(':').map((n) => +n);
    const todayArrival = new Date(now);
    todayArrival.setHours(aH, aM, 0, 0);
    const todayDeparture = new Date(now);
    todayDeparture.setHours(dH, dM, 0, 0);
    // Permitimos 30 min antes y 2h después como periodo de gracia
    const grace = 30 * 60_000;
    const tail = 120 * 60_000;
    if (now.getTime() < todayArrival.getTime() - grace) return false;
    if (now.getTime() > todayDeparture.getTime() + tail) return false;
    return true;
  }

  /**
   * Permite que la salida sea solo una hora (ej. "6pm") asumiendo el mismo día
   * que la llegada. Si el resultado es anterior a la llegada, asume el día
   * siguiente.
   */
  parseDepartureRelativeToArrival(
    text: string,
    arrival: Date,
  ): ParsedDateTime | null {
    const parsed = this.parseSpanishDateTime(text, arrival);
    if (!parsed) return null;
    let date = parsed.date;
    if (parsed.timeOnly) {
      // setTime ya alineó al "hoy" calculado desde `now=arrival`
      // Si quedó antes de la llegada, sumamos 1 día.
      if (date.getTime() <= arrival.getTime()) {
        date = new Date(date);
        date.setDate(date.getDate() + 1);
      }
    }
    return {
      date,
      timeOnly: parsed.timeOnly,
      allDay: parsed.allDay,
      humanLabel: this.formatHumanDateTime(date),
    };
  }

  // =========================================================================
  // Persistencia y QR
  // =========================================================================

  /**
   * Crea el registro de la visita en Firestore, genera y sube la imagen del QR
   * a Firebase Storage. Devuelve los datos clave para enviarlos por WhatsApp.
   *
   * Estructura: clients/{clientId}/condominiums/{condominiumId}/scheduledVisits/{visitId}
   */
  async createScheduledVisit(
    input: CreateScheduledVisitInput,
  ): Promise<CreateScheduledVisitResult> {
    const {
      clientId,
      condominiumId,
      condominiumName,
      resident,
      visitorName,
      visitorVehicle,
      visitType = 'single',
      arrivalAt,
      departureAt,
      recurrence,
      arrivalLabel,
      departureLabel,
    } = input;

    if (visitType === 'single' && (!arrivalAt || !departureAt)) {
      throw new Error('Visita única requiere arrivalAt y departureAt.');
    }
    if (visitType === 'recurring' && !recurrence) {
      throw new Error('Visita recurrente requiere recurrence.');
    }

    // ID estable para el QR — se usa en la URL pública.
    const qrId = crypto.randomUUID();
    // Token aleatorio adicional: el QR debe llevarlo para validar (no basta
    // adivinar el qrId).
    const accessToken = crypto.randomBytes(24).toString('hex');

    const visitsRef = this.firestore.collection(
      `clients/${clientId}/condominiums/${condominiumId}/${VISITS_SUBCOLLECTION}`,
    );

    // Resolver arrival/departure y expiración según el tipo de visita.
    let effectiveArrival: Date;
    let effectiveDeparture: Date;
    let expiresAt: Date;

    if (visitType === 'single') {
      effectiveArrival = arrivalAt!;
      effectiveDeparture = departureAt!;
      expiresAt = new Date(
        effectiveDeparture.getTime() + GRACE_MINUTES_AFTER_DEPARTURE * 60_000,
      );
    } else {
      // Para recurrentes guardamos la PRÓXIMA ocurrencia en arrivalAt/departureAt
      // (sirve para queries de "cuál es la próxima visita") y usamos endDate
      // de la serie como base para expiresAt.
      const next = this.nextOccurrence(recurrence!);
      if (!next) {
        throw new Error(
          'La configuración recurrente no tiene ocurrencias futuras.',
        );
      }
      effectiveArrival = next.arrival;
      effectiveDeparture = next.departure;
      expiresAt = new Date(
        recurrence!.endDate.getTime() + GRACE_MINUTES_AFTER_DEPARTURE * 60_000,
      );
    }

    // URL pública que el guardia escaneará. Apunta al FRONTEND
    // (pantalla /scheduled-visits/:qrId), que internamente llama al
    // endpoint /scheduled-visits-qr/:qrId del backend.
    // Hardcoded porque el dominio es fijo y no cambia entre entornos.
    const qrPayload = `https://estate-admin.com/scheduled-visits/${qrId}?token=${accessToken}&clientId=${clientId}&condominiumId=${condominiumId}`;

    // Generar imagen del QR como buffer PNG
    const qrBuffer = await QRCode.toBuffer(qrPayload, {
      errorCorrectionLevel: 'M',
      type: 'png',
      width: 512,
      margin: 2,
    });

    // Subir a Firebase Storage
    const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
    if (!bucketName) {
      throw new Error('FIREBASE_STORAGE_BUCKET no está configurado');
    }
    const bucket = admin.storage().bucket(bucketName);
    const fileName = `visit_${qrId}.png`;
    const filePath = `clients/${clientId}/condominiums/${condominiumId}/scheduledVisitsQR/${fileName}`;
    const storageFile = bucket.file(filePath);
    await storageFile.save(qrBuffer, {
      metadata: { contentType: 'image/png' },
    });
    await storageFile.makePublic();
    const qrImageUrl = `https://storage.googleapis.com/${bucketName}/${filePath}`;

    // Documento Firestore con TODA la información para trazabilidad.
    // Usamos qrId como docId para hacer lookups O(1) por QR.
    const docRef = visitsRef.doc(qrId);
    const visitId = docRef.id;
    const now = admin.firestore.FieldValue.serverTimestamp();
    const visitDoc: Record<string, any> = {
      id: visitId,
      // Tipo
      visitType,
      // Visitante
      visitorName: visitorName.trim(),
      visitorVehicle: visitorVehicle ?? null,
      // Fechas (Timestamps reales para queries + labels humanos)
      arrivalAt: admin.firestore.Timestamp.fromDate(effectiveArrival),
      departureAt: admin.firestore.Timestamp.fromDate(effectiveDeparture),
      expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      arrivalAtLabel: arrivalLabel,
      departureAtLabel: departureLabel,
      // Configuración de recurrencia (solo si aplica)
      recurrence:
        visitType === 'recurring' && recurrence
          ? {
              daysOfWeek: recurrence.daysOfWeek,
              dailyArrivalTime: recurrence.dailyArrivalTime,
              dailyDepartureTime: recurrence.dailyDepartureTime,
              startDate: admin.firestore.Timestamp.fromDate(recurrence.startDate),
              endDate: admin.firestore.Timestamp.fromDate(recurrence.endDate),
              timezone: recurrence.timezone || DEFAULT_TIMEZONE,
            }
          : null,
      // Trazabilidad: residente que la registró
      resident: {
        userId: resident.userId,
        email: resident.email,
        departmentNumber: resident.departmentNumber,
        tower: resident.tower ?? null,
        phoneNumber: resident.phoneNumber,
        name: resident.name ?? null,
        lastName: resident.lastName ?? null,
      },
      // Vínculo con condominio (redundante pero útil para queries collectionGroup)
      clientId,
      condominiumId,
      condominiumName: condominiumName ?? null,
      // QR
      qrId,
      accessToken,
      qrImageUrl,
      qrImageStoragePath: filePath,
      qrPayload,
      // Lifecycle
      status: 'active' as const,
      usedAt: null,
      exitAt: null,
      // Metadata
      createdVia: 'whatsapp_chatbot',
      createdAt: now,
      updatedAt: now,
    };

    await docRef.set(visitDoc);

    this.logger.log(
      `Visita programada creada: ${visitId} para ${visitorName} en ${clientId}/${condominiumId}`,
    );

    return {
      visitId,
      qrId,
      accessToken,
      qrImageUrl,
      qrPayload,
    };
  }

  /**
   * Envía la imagen del QR por WhatsApp (tipo "image").
   */
  async sendQrImageMessage(
    phoneNumber: string,
    qrImageUrl: string,
    caption: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const apiUrl = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
      const recipient = normalizeMexNumber(phoneNumber);

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'image',
        image: {
          link: qrImageUrl,
          caption,
        },
      };

      await axios.post(apiUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        },
      });

      return { success: true, message: 'QR enviado correctamente.' };
    } catch (error) {
      this.logger.error(
        `Error enviando QR a ${phoneNumber}: ${error.message}`,
        error.stack,
      );
      if (error.response) {
        this.logger.error('WhatsApp API error data:', error.response.data);
      }
      return { success: false, message: error.message };
    }
  }

  // =========================================================================
  // Validación de QR (para caseta)
  // =========================================================================

  /**
   * Busca una visita por qrId. Como qrId es único globalmente (UUID), buscamos
   * via collectionGroup. Si se pasan clientId/condominiumId, se usa la ruta
   * directa (más eficiente).
   */
  async findVisitByQrId(
    qrId: string,
    clientId?: string,
    condominiumId?: string,
  ): Promise<FirebaseFirestore.DocumentSnapshot | null> {
    if (clientId && condominiumId) {
      const ref = this.firestore.doc(
        `clients/${clientId}/condominiums/${condominiumId}/${VISITS_SUBCOLLECTION}/${qrId}`,
      );
      const snap = await ref.get();
      if (snap.exists) return snap;

      // Fallback: buscar por qrId en la subcolección (el doc ID podría ser distinto)
      const querySnap = await this.firestore
        .collection(
          `clients/${clientId}/condominiums/${condominiumId}/${VISITS_SUBCOLLECTION}`,
        )
        .where('qrId', '==', qrId)
        .limit(1)
        .get();
      if (!querySnap.empty) return querySnap.docs[0];
      return null;
    }

    const groupSnap = await this.firestore
      .collectionGroup(VISITS_SUBCOLLECTION)
      .where('qrId', '==', qrId)
      .limit(1)
      .get();
    if (!groupSnap.empty) return groupSnap.docs[0];
    return null;
  }

  /**
   * Valida un QR escaneado por la caseta. No modifica el estado: solo lo
   * inspecciona y devuelve si es válido para entrada / salida.
   */
  async validateVisitQr(
    qrId: string,
    token: string,
    clientId?: string,
    condominiumId?: string,
  ): Promise<{
    valid: boolean;
    reason?: string;
    visit?: any;
  }> {
    const snap = await this.findVisitByQrId(qrId, clientId, condominiumId);
    if (!snap || !snap.exists) {
      return { valid: false, reason: 'QR no encontrado.' };
    }
    const data = snap.data() as any;

    if (!token || data.accessToken !== token) {
      return { valid: false, reason: 'Token inválido.' };
    }
    if (data.status === 'cancelled') {
      return { valid: false, reason: 'Visita cancelada.' };
    }
    if (data.status === 'expired') {
      return { valid: false, reason: 'Visita expirada.' };
    }

    const nowDate = new Date();
    const expiresAt: admin.firestore.Timestamp | undefined = data.expiresAt;
    if (expiresAt && expiresAt.toMillis() < nowDate.getTime()) {
      await snap.ref.update({
        status: 'expired',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { valid: false, reason: 'Visita expirada.' };
    }

    // Validación específica por tipo de visita
    const isRecurring = data.visitType === 'recurring' && data.recurrence;
    if (isRecurring) {
      const r = data.recurrence;
      const recurrence: VisitRecurrence = {
        daysOfWeek: r.daysOfWeek,
        dailyArrivalTime: r.dailyArrivalTime,
        dailyDepartureTime: r.dailyDepartureTime,
        startDate: r.startDate.toDate(),
        endDate: r.endDate.toDate(),
        timezone: r.timezone,
      };
      if (!this.isWithinRecurrenceWindow(recurrence, nowDate)) {
        return {
          valid: false,
          reason:
            'Fuera de la ventana válida (día u hora no coincide con la programación).',
        };
      }
    }
    // Para 'single' no aplicamos check de ventana — si no expiró, es válido en
    // cualquier momento del rango (la caseta es la responsable del juicio final).

    return {
      valid: true,
      visit: {
        id: snap.id,
        visitType: data.visitType || 'single',
        visitorName: data.visitorName,
        arrivalAt: data.arrivalAtLabel,
        departureAt: data.departureAtLabel,
        recurrence: data.recurrence
          ? {
              daysOfWeek: data.recurrence.daysOfWeek,
              dailyArrivalTime: data.recurrence.dailyArrivalTime,
              dailyDepartureTime: data.recurrence.dailyDepartureTime,
              startDate: data.recurrence.startDate?.toDate?.() ?? null,
              endDate: data.recurrence.endDate?.toDate?.() ?? null,
            }
          : null,
        status: data.status,
        usedAt: data.usedAt,
        exitAt: data.exitAt,
        resident: data.resident,
        condominiumName: data.condominiumName,
      },
    };
  }

  /**
   * Marca un QR como usado (entrada o salida).
   *
   * - Para visitas 'single': permite UNA entrada y UNA salida en el documento
   *   raíz (mismo comportamiento original).
   * - Para visitas 'recurring': cada entrada/salida se guarda como documento
   *   en la subcolección `entries`, y se actualizan los punteros lastUsedAt /
   *   lastExitAt en el documento raíz para queries rápidos.
   */
  async registerVisitEntry(
    qrId: string,
    token: string,
    type: 'check-in' | 'check-out',
    clientId?: string,
    condominiumId?: string,
  ): Promise<{ ok: boolean; reason?: string; entryId?: string }> {
    const snap = await this.findVisitByQrId(qrId, clientId, condominiumId);
    if (!snap || !snap.exists) {
      return { ok: false, reason: 'QR no encontrado.' };
    }
    const data = snap.data() as any;
    if (data.accessToken !== token) {
      return { ok: false, reason: 'Token inválido.' };
    }
    if (data.status === 'cancelled' || data.status === 'expired') {
      return { ok: false, reason: `Visita ${data.status}.` };
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const isRecurring = data.visitType === 'recurring' && data.recurrence;

    if (isRecurring) {
      // Validar ventana antes de registrar
      const r = data.recurrence;
      const recurrence: VisitRecurrence = {
        daysOfWeek: r.daysOfWeek,
        dailyArrivalTime: r.dailyArrivalTime,
        dailyDepartureTime: r.dailyDepartureTime,
        startDate: r.startDate.toDate(),
        endDate: r.endDate.toDate(),
      };
      if (!this.isWithinRecurrenceWindow(recurrence, new Date())) {
        return {
          ok: false,
          reason: 'Fuera de la ventana válida para esta visita recurrente.',
        };
      }

      // Para evitar duplicados del mismo día, buscamos si ya existe entry
      // de hoy con el mismo type.
      const today0 = new Date();
      today0.setHours(0, 0, 0, 0);
      const tomorrow0 = new Date(today0);
      tomorrow0.setDate(tomorrow0.getDate() + 1);

      const existing = await snap.ref
        .collection('entries')
        .where('type', '==', type)
        .where('createdAt', '>=', admin.firestore.Timestamp.fromDate(today0))
        .where('createdAt', '<', admin.firestore.Timestamp.fromDate(tomorrow0))
        .limit(1)
        .get();
      if (!existing.empty) {
        return {
          ok: false,
          reason: `Ya hay un ${type} registrado hoy para esta visita.`,
        };
      }

      const entryRef = snap.ref.collection('entries').doc();
      await entryRef.set({
        id: entryRef.id,
        type,
        createdAt: now,
      });

      // Actualizar punteros + próxima ocurrencia
      const nextOcc = this.nextOccurrence(recurrence, new Date(Date.now() + 60_000));
      const updates: Record<string, any> = {
        updatedAt: now,
      };
      if (type === 'check-in') updates.lastUsedAt = now;
      else updates.lastExitAt = now;
      if (nextOcc) {
        updates.arrivalAt = admin.firestore.Timestamp.fromDate(nextOcc.arrival);
        updates.departureAt = admin.firestore.Timestamp.fromDate(nextOcc.departure);
      }
      await snap.ref.update(updates);

      return { ok: true, entryId: entryRef.id };
    }

    // Single (comportamiento original)
    if (type === 'check-in') {
      if (data.usedAt) {
        return { ok: false, reason: 'La visita ya tenía registro de entrada.' };
      }
      await snap.ref.update({
        usedAt: now,
        status: 'used',
        updatedAt: now,
      });
      return { ok: true };
    } else {
      if (data.exitAt) {
        return { ok: false, reason: 'La visita ya tenía registro de salida.' };
      }
      await snap.ref.update({
        exitAt: now,
        updatedAt: now,
      });
      return { ok: true };
    }
  }

  /**
   * Marca como expiradas todas las visitas activas cuya `expiresAt` ya pasó.
   * Pensado para ser llamado por un cron del lado del WhatsappChatBotService
   * (que ya tiene `@nestjs/schedule` configurado).
   */
  async expireOverdueVisits(batchSize = 50): Promise<number> {
    const now = admin.firestore.Timestamp.now();
    const snap = await this.firestore
      .collectionGroup(VISITS_SUBCOLLECTION)
      .where('status', '==', 'active')
      .where('expiresAt', '<=', now)
      .limit(batchSize)
      .get();

    if (snap.empty) return 0;

    const batch = this.firestore.batch();
    snap.docs.forEach((doc) => {
      batch.update(doc.ref, {
        status: 'expired',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    await batch.commit();
    this.logger.log(`Expiradas automáticamente ${snap.size} visitas vencidas.`);
    return snap.size;
  }
}
