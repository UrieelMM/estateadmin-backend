import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';

export interface CommonArea {
  id: string;
  uid?: string;
  name: string;
  description?: string;
  capacity?: number;
  rate: number; // Tarifa por hora en centavos
  isReservable: boolean;
  openTime: string; // "HH:MM"
  closeTime: string; // "HH:MM"
  status: 'active' | 'maintenance' | 'inactive';
  maintenanceNotes?: string;
}

export interface CreateReservationInput {
  clientId: string;
  condominiumId: string;
  userId: string;
  residentName: string;
  residentNumber: string;
  residentPhone: string;
  residentEmail: string;
  commonArea: CommonArea;
  eventDay: string; // YYYY-MM-DD
  startTime: string; // HH:MM
  endTime: string; // HH:MM
}

export interface CreateReservationResult {
  folio: string;
  reservationId: string;
  totalCost: number;
  hours: number;
}

const COMMON_AREAS_SUBCOLLECTION = 'commonAreas';
const CALENDAR_EVENTS_SUBCOLLECTION = 'calendarEvents';

@Injectable()
export class CommonAreasBookingService implements OnModuleInit {
  private readonly logger = new Logger(CommonAreasBookingService.name);
  private firestore: admin.firestore.Firestore;

  onModuleInit() {
    this.firestore = admin.firestore();
    this.logger.log('CommonAreasBookingService inicializado.');
  }

  // =========================================================================
  // Consultas de Firestore
  // =========================================================================

  /**
   * Obtiene las áreas comunes activas y reservables del condominio,
   * ordenadas por nombre.
   */
  async getActiveCommonAreas(
    clientId: string,
    condominiumId: string,
  ): Promise<CommonArea[]> {
    const path = `clients/${clientId}/condominiums/${condominiumId}/${COMMON_AREAS_SUBCOLLECTION}`;
    try {
      const snapshot = await this.firestore
        .collection(path)
        .orderBy('name', 'asc')
        .get();

      const areas: CommonArea[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        if (data.status === 'active' && data.isReservable !== false) {
          areas.push({
            id: doc.id,
            uid: data.uid || doc.id,
            name: data.name,
            description: data.description,
            capacity: data.capacity,
            rate: data.rate ?? 0,
            isReservable: data.isReservable ?? true,
            openTime: data.openTime || '00:00',
            closeTime: data.closeTime || '23:59',
            status: data.status,
            maintenanceNotes: data.maintenanceNotes,
          });
        }
      });
      return areas;
    } catch (error) {
      this.logger.error(`Error obteniendo áreas comunes: ${error.message}`);
      return [];
    }
  }

  /**
   * Obtiene un área común específica por su ID.
   */
  async getCommonAreaById(
    clientId: string,
    condominiumId: string,
    areaId: string,
  ): Promise<CommonArea | null> {
    try {
      const docRef = this.firestore.doc(
        `clients/${clientId}/condominiums/${condominiumId}/${COMMON_AREAS_SUBCOLLECTION}/${areaId}`,
      );
      const snap = await docRef.get();
      if (!snap.exists) return null;
      const data = snap.data()!;
      return {
        id: snap.id,
        uid: data.uid || snap.id,
        name: data.name,
        description: data.description,
        capacity: data.capacity,
        rate: data.rate ?? 0,
        isReservable: data.isReservable ?? true,
        openTime: data.openTime || '00:00',
        closeTime: data.closeTime || '23:59',
        status: data.status,
        maintenanceNotes: data.maintenanceNotes,
      };
    } catch (error) {
      this.logger.error(`Error obteniendo área ${areaId}: ${error.message}`);
      return null;
    }
  }

  /**
   * Verifica si el usuario tiene cargos pendientes (adeudos sin pagar).
   * Retorna el array de cargos no pagados.
   */
  async checkUnpaidCharges(
    clientId: string,
    condominiumId: string,
    userId: string,
  ): Promise<Array<{ id: string; concept: string; amount: number }>> {
    try {
      const chargesPath = `clients/${clientId}/condominiums/${condominiumId}/users/${userId}/charges`;
      const snapshot = await this.firestore
        .collection(chargesPath)
        .where('paid', '==', false)
        .get();

      const unpaid: Array<{ id: string; concept: string; amount: number }> = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        unpaid.push({
          id: doc.id,
          concept: data.concept || 'Sin concepto',
          amount: data.amount ?? 0,
        });
      });
      return unpaid;
    } catch (error) {
      this.logger.warn(
        `No se pudo verificar adeudos de ${userId}: ${error.message}`,
      );
      return [];
    }
  }

  /**
   * Verifica si hay conflicto de horario con reservaciones existentes del área.
   * Retorna true si hay empalme.
   */
  async checkConflictingReservations(
    clientId: string,
    condominiumId: string,
    commonAreaId: string,
    eventDay: string, // YYYY-MM-DD
    startTime: string, // HH:MM
    endTime: string, // HH:MM
  ): Promise<boolean> {
    try {
      const eventsPath = `clients/${clientId}/condominiums/${condominiumId}/${CALENDAR_EVENTS_SUBCOLLECTION}`;
      const snapshot = await this.firestore
        .collection(eventsPath)
        .where('commonAreaId', '==', commonAreaId)
        .where('eventDay', '==', eventDay)
        .get();

      if (snapshot.empty) return false;

      const toMinutes = (t: string): number => {
        const [h, m] = t.split(':').map(Number);
        return h * 60 + m;
      };

      const newStart = toMinutes(startTime);
      const newEnd = toMinutes(endTime);

      for (const doc of snapshot.docs) {
        const data = doc.data();
        // Ignorar reservas canceladas
        if (data.status === 'cancelled') continue;
        const existStart = toMinutes(data.startTime);
        const existEnd = toMinutes(data.endTime);
        // Overlap: el nuevo empieza antes de que termine el existente
        //          Y el nuevo termina después de que empieza el existente
        if (newStart < existEnd && newEnd > existStart) {
          return true;
        }
      }
      return false;
    } catch (error) {
      this.logger.warn(`Error al verificar conflictos: ${error.message}`);
      return false;
    }
  }

  // =========================================================================
  // Cálculos y validaciones
  // =========================================================================

  /**
   * Calcula el costo total de la reserva.
   * La tarifa está en centavos por hora; redondea hacia arriba la duración.
   */
  calculateCost(
    rate: number, // centavos por hora
    startTime: string, // HH:MM
    endTime: string, // HH:MM
  ): { cost: number; hours: number } {
    if (!rate || rate === 0) return { cost: 0, hours: 0 };

    const toMinutes = (t: string): number => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };

    let durationMinutes = toMinutes(endTime) - toMinutes(startTime);
    if (durationMinutes <= 0) durationMinutes += 24 * 60;

    const hours = Math.ceil(durationMinutes / 60);
    return { cost: rate * hours, hours };
  }

  /**
   * Valida que el horario solicitado esté dentro del horario permitido del área
   * y que el fin sea posterior al inicio.
   */
  validateTimeRange(
    startTime: string,
    endTime: string,
    openTime: string,
    closeTime: string,
  ): boolean {
    const toMinutes = (t: string): number => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    };
    const start = toMinutes(startTime);
    const end = toMinutes(endTime);
    const open = toMinutes(openTime);
    const close = toMinutes(closeTime);
    return start >= open && end <= close && end > start;
  }

  /**
   * Parsea una fecha en formato DD/MM/YYYY, DD-MM-YYYY o YYYY-MM-DD.
   * Retorna YYYY-MM-DD normalizado, o null si es inválida.
   */
  parseDate(text: string): string | null {
    const cleaned = text.trim();

    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
      const d = new Date(cleaned + 'T12:00:00');
      if (isNaN(d.getTime())) return null;
      return cleaned;
    }

    // DD/MM/YYYY o DD-MM-YYYY (con o sin año)
    const match = /^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/.exec(
      cleaned,
    );
    if (match) {
      const day = parseInt(match[1], 10);
      const month = parseInt(match[2], 10);
      let year = match[3]
        ? parseInt(match[3], 10)
        : new Date().getFullYear();
      if (year < 100) year += 2000;
      if (day < 1 || day > 31 || month < 1 || month > 12) return null;
      const d = new Date(year, month - 1, day);
      if (isNaN(d.getTime())) return null;
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    return null;
  }

  /**
   * Parsea una hora en varios formatos: HH:MM, H:MM, 8am, 14h, 8:30pm, etc.
   * Retorna HH:MM en formato 24h, o null si no es válida.
   */
  parseTime(text: string): string | null {
    const cleaned = text.trim().toLowerCase().replace(/^a\s+las\s+/, '');
    const match =
      /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|h|hrs)?$/.exec(cleaned);
    if (!match) return null;

    let hour = parseInt(match[1], 10);
    const minute = match[2] ? parseInt(match[2], 10) : 0;
    const meridian = match[3];

    if (meridian === 'am') {
      if (hour === 12) hour = 0;
    } else if (meridian === 'pm') {
      if (hour !== 12) hour += 12;
    }

    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  /**
   * Valida que la fecha no sea anterior al día de hoy.
   */
  isDateValid(dateStr: string): boolean {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const d = new Date(dateStr + 'T00:00:00');
    return !isNaN(d.getTime()) && d >= today;
  }

  // =========================================================================
  // Creación de la reservación
  // =========================================================================

  /**
   * Genera un folio único para la reservación con formato RES-YYYYMMDD-XXXXXX.
   */
  generateFolio(): string {
    const now = new Date();
    const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const random = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `RES-${date}-${random}`;
  }

  /**
   * Crea la reservación en Firestore (colección calendarEvents del condominio).
   */
  async createReservation(
    input: CreateReservationInput,
  ): Promise<CreateReservationResult> {
    const {
      clientId,
      condominiumId,
      userId,
      residentName,
      residentNumber,
      residentPhone,
      residentEmail,
      commonArea,
      eventDay,
      startTime,
      endTime,
    } = input;

    const folio = this.generateFolio();
    const { cost: totalCost, hours } = this.calculateCost(
      commonArea.rate,
      startTime,
      endTime,
    );

    const eventsPath = `clients/${clientId}/condominiums/${condominiumId}/${CALENDAR_EVENTS_SUBCOLLECTION}`;
    const docRef = this.firestore.collection(eventsPath).doc();
    const now = admin.firestore.FieldValue.serverTimestamp();

    const reservationDoc = {
      id: docRef.id,
      folio,
      name: residentName,
      number: residentNumber,
      phone: residentPhone,
      email: residentEmail,
      userId,
      commonArea: commonArea.name,
      commonAreaId: commonArea.uid || commonArea.id,
      eventDay,
      startTime,
      endTime,
      totalCost,
      hours,
      status: 'active',
      createdVia: 'whatsapp_chatbot',
      createdAt: now,
      updatedAt: now,
    };

    await docRef.set(reservationDoc);

    this.logger.log(
      `Reservación creada: ${folio} | ${residentName} | ${commonArea.name} | ${eventDay} ${startTime}-${endTime} | ${clientId}/${condominiumId}`,
    );

    return { folio, reservationId: docRef.id, totalCost, hours };
  }

  // =========================================================================
  // Helpers de formato
  // =========================================================================

  /**
   * Formatea centavos a pesos MXN legibles: "$1,200.00".
   */
  formatCurrency(cents: number): string {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN',
    }).format(cents / 100);
  }

  /**
   * Formatea una fecha YYYY-MM-DD a formato largo en español:
   * "martes, 20 de mayo de 2025".
   */
  formatDate(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00');
    return d.toLocaleDateString('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  }
}
