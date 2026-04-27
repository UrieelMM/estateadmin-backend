import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios from 'axios';
import * as admin from 'firebase-admin';
import { PaymentConfirmationDto } from 'src/dtos/whatsapp/payment-confirmation.dto';
import { WhatsappMessageDto } from 'src/dtos/whatsapp/whatsapp-message.dto';
import { normalizeMexNumber } from './formatNumber';
import {
  PublicDocumentsService,
  DocumentsConfig,
  PublicDocument,
} from './public-documents.service';
import {
  AccountStatementService,
  ProcessedAccountData,
} from './account-statement.service';
import {
  ScheduledVisitsService,
  ParsedDateTime,
} from './scheduled-visits.service';

// Asegúrate de inicializar Firebase Admin en tu módulo principal (e.g., app.module.ts)
// import * as admin from 'firebase-admin';
// admin.initializeApp({ ... }); // Configuración de Firebase

/**
 * Estados del flujo conversacional.
 */
enum ConversationState {
  INITIAL = 'INITIAL',
  MENU_SELECTION = 'MENU_SELECTION',

  // Estados para registrar comprobante (flujo original)
  PAYMENT_AWAITING_EMAIL = 'PAYMENT_AWAITING_EMAIL',
  PAYMENT_AWAITING_DEPARTMENT = 'PAYMENT_AWAITING_DEPARTMENT',
  PAYMENT_AWAITING_TOWER = 'PAYMENT_AWAITING_TOWER',
  PAYMENT_MULTIPLE_CONDOMINIUMS = 'PAYMENT_MULTIPLE_CONDOMINIUMS',
  PAYMENT_AWAITING_CONDOMINIUM_SELECTION = 'PAYMENT_AWAITING_CONDOMINIUM_SELECTION',
  PAYMENT_AWAITING_CHARGE_SELECTION = 'PAYMENT_AWAITING_CHARGE_SELECTION',
  PAYMENT_AWAITING_FILE = 'PAYMENT_AWAITING_FILE',

  // Estados para consultar documentos (nuevo flujo)
  DOCUMENTS_AWAITING_EMAIL = 'DOCUMENTS_AWAITING_EMAIL',
  DOCUMENTS_AWAITING_DEPARTMENT = 'DOCUMENTS_AWAITING_DEPARTMENT',
  DOCUMENTS_AWAITING_TOWER = 'DOCUMENTS_AWAITING_TOWER',
  DOCUMENTS_MULTIPLE_CONDOMINIUMS = 'DOCUMENTS_MULTIPLE_CONDOMINIUMS',
  DOCUMENTS_AWAITING_CONDOMINIUM_SELECTION = 'DOCUMENTS_AWAITING_CONDOMINIUM_SELECTION',
  DOCUMENTS_AWAITING_DOCUMENT_SELECTION = 'DOCUMENTS_AWAITING_DOCUMENT_SELECTION',

  // Estados para estado de cuenta (nuevo flujo)
  ACCOUNT_AWAITING_EMAIL = 'ACCOUNT_AWAITING_EMAIL',
  ACCOUNT_AWAITING_DEPARTMENT = 'ACCOUNT_AWAITING_DEPARTMENT',
  ACCOUNT_AWAITING_TOWER = 'ACCOUNT_AWAITING_TOWER',
  ACCOUNT_MULTIPLE_CONDOMINIUMS = 'ACCOUNT_MULTIPLE_CONDOMINIUMS',
  ACCOUNT_AWAITING_CONDOMINIUM_SELECTION = 'ACCOUNT_AWAITING_CONDOMINIUM_SELECTION',
  ACCOUNT_GENERATING = 'ACCOUNT_GENERATING',

  // Estados para registrar visita programada (opción 4)
  VISIT_AWAITING_EMAIL = 'VISIT_AWAITING_EMAIL',
  VISIT_AWAITING_DEPARTMENT = 'VISIT_AWAITING_DEPARTMENT',
  VISIT_AWAITING_TOWER = 'VISIT_AWAITING_TOWER',
  VISIT_AWAITING_CONDOMINIUM_SELECTION = 'VISIT_AWAITING_CONDOMINIUM_SELECTION',
  VISIT_AWAITING_TYPE = 'VISIT_AWAITING_TYPE',
  VISIT_AWAITING_VISITOR_NAME = 'VISIT_AWAITING_VISITOR_NAME',
  // Flujo único
  VISIT_AWAITING_ARRIVAL = 'VISIT_AWAITING_ARRIVAL',
  VISIT_AWAITING_DEPARTURE = 'VISIT_AWAITING_DEPARTURE',
  // Flujo recurrente
  VISIT_AWAITING_DAYS_OF_WEEK = 'VISIT_AWAITING_DAYS_OF_WEEK',
  VISIT_AWAITING_DAILY_ARRIVAL = 'VISIT_AWAITING_DAILY_ARRIVAL',
  VISIT_AWAITING_DAILY_DEPARTURE = 'VISIT_AWAITING_DAILY_DEPARTURE',
  VISIT_AWAITING_START_DATE = 'VISIT_AWAITING_START_DATE',
  VISIT_AWAITING_END_DATE = 'VISIT_AWAITING_END_DATE',
  // Compartidos final
  VISIT_AWAITING_VEHICLE = 'VISIT_AWAITING_VEHICLE',
  VISIT_CONFIRMING = 'VISIT_CONFIRMING',

  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
}

/**
 * Estructura para mantener el contexto de conversación de cada usuario (ahora en Firestore).
 */
interface ConversationContext {
  state: ConversationState;
  phoneNumber: string; // Ej. '5215531139560'
  email?: string;
  departmentNumber?: string;
  // Torre/bloque del residente. Se utiliza solo en condominios cuyos residentes
  // tienen el campo `tower` poblado en Firestore. Si no aplica, queda undefined.
  tower?: string;
  // Lista de torres candidatas cuando hay ambigüedad (mismo email+number en
  // distintas torres). Se llena únicamente cuando se requiere preguntar.
  possibleTowers?: string[];
  possibleCondominiums?: Array<{
    clientId: string;
    condominiumId: string;
    condominiumName?: string;
    userId?: string;
    tower?: string;
    phoneMatches?: boolean;
    phoneInDB?: boolean;
  }>;
  selectedCondominium?: {
    clientId: string;
    condominiumId: string;
    condominiumName?: string;
    userId?: string;
    tower?: string;
    phoneMatches?: boolean;
    phoneInDB?: boolean;
  };
  // Para flujo de pagos
  pendingCharges?: Array<{
    index: number;
    id: string;
    concept: string;
    amount: number;
  }>;
  selectedChargeIds?: string[];
  // Para flujo de documentos
  availableDocuments?: DocumentsConfig;
  documentKeys?: string[];
  // Para flujo de visitas programadas
  visitDraft?: {
    visitType?: 'single' | 'recurring';
    visitorName?: string;
    // Visita única
    arrivalAtISO?: string; // ISO string para serializar en Firestore
    arrivalLabel?: string;
    departureAtISO?: string;
    departureLabel?: string;
    // Visita recurrente
    daysOfWeek?: number[]; // 0..6
    dailyArrivalTime?: string; // "HH:MM" 24h
    dailyDepartureTime?: string;
    startDateISO?: string; // 00:00 del primer día
    endDateISO?: string;   // 23:59:59 del último día
    vehiclePlates?: string;
    vehicleDescription?: string;
  };
  lastInteractionTimestamp?: admin.firestore.Timestamp;
  userId?: string;
  // Control de reintentos por campo
  retryCount?: number;
}

// Colecciones de Firestore
const STATE_COLLECTION = 'whatsappConversationState';
const AUDIT_COLLECTION_BASE = 'clients'; // Base para la ruta de auditoría

@Injectable()
export class WhatsappChatBotService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappChatBotService.name);
  private firestore: admin.firestore.Firestore;

  constructor(
    private readonly publicDocumentsService: PublicDocumentsService,
    private readonly accountStatementService: AccountStatementService,
    private readonly scheduledVisitsService: ScheduledVisitsService,
  ) {}

  onModuleInit() {
    // Asegura que tenemos la instancia de Firestore disponible
    this.firestore = admin.firestore();
    this.logger.log(
      'WhatsappChatBotService inicializado y Firestore conectado.',
    );
  }

  // --- Funciones de Persistencia y Auditoría ---

  /**
   * Obtiene el contexto de conversación desde Firestore.
   * Si no existe, crea uno inicial.
   */
  private async getConversationContext(
    phoneNumber: string,
  ): Promise<ConversationContext> {
    const docRef = this.firestore.collection(STATE_COLLECTION).doc(phoneNumber);
    const docSnap = await docRef.get();

    if (docSnap.exists) {
      this.logger.log(`Contexto encontrado para ${phoneNumber}`);
      // Asegurarse de que los Timestamps se manejen correctamente si es necesario
      return docSnap.data() as ConversationContext;
    } else {
      this.logger.log(`Creando contexto inicial para ${phoneNumber}`);
      const initialContext: ConversationContext = {
        state: ConversationState.INITIAL,
        phoneNumber: phoneNumber,
        lastInteractionTimestamp:
          admin.firestore.FieldValue.serverTimestamp() as admin.firestore.Timestamp,
      };
      // No lo guardamos aquí todavía, se guardará después del primer manejo
      return initialContext;
    }
  }

  /**
   * Guarda el contexto de conversación actual en Firestore.
   */
  private async saveConversationContext(
    context: ConversationContext,
  ): Promise<void> {
    try {
      const docRef = this.firestore
        .collection(STATE_COLLECTION)
        .doc(context.phoneNumber);
      // Actualiza el timestamp de última interacción
      context.lastInteractionTimestamp =
        admin.firestore.FieldValue.serverTimestamp() as admin.firestore.Timestamp;

      // Guardar en la colección original
      await docRef.set(context, { merge: true });
      this.logger.log(`Contexto guardado para ${context.phoneNumber}`);
    } catch (error) {
      this.logger.error(
        `Error al guardar contexto para ${context.phoneNumber}: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Registra un evento de mensaje (entrante/saliente) en la colección de auditoría.
   */
  private async logToAudit(
    context: ConversationContext | null, // Puede ser nulo si el contexto aún no se ha establecido completamente
    direction: 'in' | 'out',
    messageContent: string | object, // Puede ser texto o un objeto (ej. webhook)
    details: Record<string, any> = {}, // Datos adicionales
  ): Promise<void> {
    const phoneNumber =
      context?.phoneNumber || details.phoneNumber || 'unknown'; // Intentar obtener el número
    const clientId = context?.selectedCondominium?.clientId || details.clientId;
    const condominiumId =
      context?.selectedCondominium?.condominiumId || details.condominiumId;

    // Validación estricta: solo audita en la ruta específica si tenemos clientId y condominiumId válidos
    const isValidClientId =
      clientId &&
      typeof clientId === 'string' &&
      clientId.trim().length > 0 &&
      clientId !== 'undefined' &&
      clientId !== 'null';

    const isValidCondominiumId =
      condominiumId &&
      typeof condominiumId === 'string' &&
      condominiumId.trim().length > 0 &&
      condominiumId !== 'undefined' &&
      condominiumId !== 'null';

    if (isValidClientId && isValidCondominiumId) {
      // Usuario registrado: guardar en la ruta específica del condominio
      const auditPath = `${AUDIT_COLLECTION_BASE}/${clientId}/condominiums/${condominiumId}/whatsAppBotAudit`;
      try {
        const auditLog = {
          phoneNumber: phoneNumber,
          direction: direction,
          message: messageContent,
          state: context?.state || 'UNKNOWN',
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          userId: context?.userId, // Incluir userId si está disponible
          userType: 'registered', // Marcar como usuario registrado
          ...details, // Añadir cualquier detalle extra
        };
        await this.firestore.collection(auditPath).add(auditLog);
        this.logger.log(
          `Auditoría registrada en ${auditPath} para ${phoneNumber}`,
        );
      } catch (error) {
        this.logger.error(
          `Error al registrar auditoría en ${auditPath} para ${phoneNumber}: ${error.message}`,
          error.stack,
        );
      }
    } else {
      // Usuario no registrado: guardar en colección genérica para análisis
      try {
        const genericAuditLog = {
          phoneNumber: phoneNumber,
          direction: direction,
          message: messageContent,
          state: context?.state || 'UNKNOWN',
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          userType: 'unregistered', // Marcar como usuario no registrado
          attemptedClientId: clientId || null, // Guardar lo que se intentó usar
          attemptedCondominiumId: condominiumId || null, // Guardar lo que se intentó usar
          ...details,
        };

        await this.firestore
          .collection('whatsAppBotAudit_Unregistered')
          .add(genericAuditLog);
        this.logger.log(
          `Auditoría de usuario no registrado guardada para ${phoneNumber}`,
        );
      } catch (error) {
        this.logger.error(
          `Error al registrar auditoría genérica para ${phoneNumber}: ${error.message}`,
          error.stack,
        );
      }
    }
  }

  // --- Funciones Principales del Chatbot ---

  /**
   * Envía un mensaje de texto a través de la API de WhatsApp y lo registra en auditoría.
   */
  async sendAndLogMessage(
    whatsappMessageDto: WhatsappMessageDto,
    context?: ConversationContext, // Pasar contexto para auditoría
  ): Promise<{ success: boolean; message: string; data?: any }> {
    try {
      this.logger.log(
        `Enviando mensaje a ${whatsappMessageDto.phoneNumber}: "${whatsappMessageDto.message}"`,
      );

      const apiUrl = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
      const recipientPhoneNumber = normalizeMexNumber(
        whatsappMessageDto.phoneNumber,
      ); // Normalizar número

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientPhoneNumber,
        type: 'text',
        text: { body: whatsappMessageDto.message },
      };

      const response = await axios.post(apiUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        },
      });

      // Registrar en auditoría DESPUÉS de enviar exitosamente
      await this.logToAudit(
        context || null, // Usar el contexto si está disponible
        'out',
        whatsappMessageDto.message,
        { phoneNumber: whatsappMessageDto.phoneNumber }, // Asegurar que el número esté en los detalles si no hay contexto
      );

      return {
        success: true,
        message: 'Mensaje enviado correctamente.',
        data: response.data,
      };
    } catch (error) {
      this.logger.error(
        `Error al enviar mensaje a ${whatsappMessageDto.phoneNumber}: ${error.message}`,
        error.stack,
      );
      if (error.response) {
        this.logger.error('WhatsApp API error data:', error.response.data);
      }
      // No registrar en auditoría si falló el envío
      // Considerar si se debe guardar el estado como ERROR aquí
      if (context) {
        context.state = ConversationState.ERROR;
        await this.saveConversationContext(context);
      }
      // No relanzar el error necesariamente, depende de tu manejo global de errores
      return {
        success: false,
        message: `Error al enviar mensaje: ${error.message}`,
      };
    }
  }

  /**
   * Procesa el webhook entrante de WhatsApp y dirige el flujo conversacional.
   */
  async processWebhook(webhookData: any) {
    try {
      this.logger.log('Procesando webhook de WhatsApp...'); // Evitar loguear todo el webhook si contiene datos sensibles

      const entry = webhookData.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const messageObj = value?.messages?.[0];

      if (!messageObj) {
        // Podría ser un evento de status, etc. Ignorar si no es un mensaje.
        this.logger.log('Webhook recibido, pero no es un mensaje de usuario.');
        return {
          success: true,
          message: 'No es un mensaje de usuario procesable.',
        };
      }

      const from = messageObj.from; // Ej: '5215531139560'
      this.logger.log(`Mensaje recibido desde: ${from}`);

      // Obtener contexto desde Firestore
      let context = await this.getConversationContext(from);

      // --- Auditoría del Mensaje Entrante ---
      let incomingMessageContent: string | object =
        'Tipo de mensaje no textual';
      if (messageObj.type === 'text') {
        incomingMessageContent = messageObj.text?.body || '';
      } else if (messageObj.type === 'image') {
        incomingMessageContent = {
          type: 'image',
          id: messageObj.image?.id,
          mime_type: messageObj.image?.mime_type,
        };
      } else if (messageObj.type === 'document') {
        incomingMessageContent = {
          type: 'document',
          id: messageObj.document?.id,
          mime_type: messageObj.document?.mime_type,
        };
      }
      // Registrar auditoría del mensaje entrante (intentar usar el contexto actual si existe)
      await this.logToAudit(context, 'in', incomingMessageContent);
      // --- Fin Auditoría ---

      // Manejar tipos de mensaje
      if (messageObj.type === 'text') {
        const textBody = messageObj.text?.body || '';
        const normalizedText = this.cleanInput(textBody);
        await this.handleConversation(context, normalizedText);
      } else if (messageObj.type === 'image') {
        this.logger.log(`Recibimos un archivo tipo imagen 📷 de ${from}`);
        const mediaId = messageObj.image.id;
        const mimeType = messageObj.image.mime_type || 'image/jpeg'; // Default a jpeg si no viene

        if (
          context.state === ConversationState.PAYMENT_AWAITING_FILE &&
          context.selectedCondominium
        ) {
          const { clientId, condominiumId } = context.selectedCondominium;
          try {
            const fileUrl = await this.downloadAndUploadMedia(
              mediaId,
              mimeType,
              clientId,
              condominiumId,
            );
            const paymentResult = await this.registerPayment(context, fileUrl);
            if (paymentResult.success) {
              context.state = ConversationState.COMPLETED;
              await this.sendAndLogMessage(
                {
                  phoneNumber: from,
                  message:
                    '✅ ¡Excelente! Hemos recibido tu imagen y registrado tu comprobante con éxito. ¡Muchas gracias! 🙌',
                },
                context,
              );
            }
            // Si paymentResult.success === false, registerPayment ya envió el mensaje de error
          } catch (uploadError) {
            this.logger.error(
              `Error al procesar imagen de ${from}: ${uploadError.message}`,
              uploadError.stack,
            );
            context.state = ConversationState.ERROR;
            await this.sendAndLogMessage(
              {
                phoneNumber: from,
                message:
                  '😥 ¡Ups! Hubo un problema al procesar tu imagen. Por favor, intenta enviarla de nuevo en unos momentos. Si el problema persiste, contacta a soporte.',
              },
              context,
            );
          }
        } else {
          await this.sendAndLogMessage(
            {
              phoneNumber: from,
              message: `Recibí tu imagen, pero no estaba esperando un archivo en este momento. 😊\n\n${this.getMenuMessage()}`,
            },
            context,
          );
        }
      } else if (messageObj.type === 'document') {
        this.logger.log(`Recibimos un archivo tipo documento 📄 de ${from}`);
        const mediaId = messageObj.document.id;
        const mimeType = messageObj.document.mime_type || 'application/pdf'; // Default a pdf

        if (
          context.state === ConversationState.PAYMENT_AWAITING_FILE &&
          context.selectedCondominium
        ) {
          const { clientId, condominiumId } = context.selectedCondominium;
          try {
            const fileUrl = await this.downloadAndUploadMedia(
              mediaId,
              mimeType,
              clientId,
              condominiumId,
            );
            const paymentResult = await this.registerPayment(context, fileUrl);
            if (paymentResult.success) {
              context.state = ConversationState.COMPLETED;
              await this.sendAndLogMessage(
                {
                  phoneNumber: from,
                  message:
                    '✅ ¡Perfecto! Recibimos tu documento y hemos registrado tu comprobante exitosamente. ¡Gracias! 🥳',
                },
                context,
              );
            }
            // Si paymentResult.success === false, registerPayment ya envió el mensaje de error
          } catch (uploadError) {
            this.logger.error(
              `Error al procesar documento de ${from}: ${uploadError.message}`,
              uploadError.stack,
            );
            context.state = ConversationState.ERROR;
            await this.sendAndLogMessage(
              {
                phoneNumber: from,
                message:
                  '😥 ¡Vaya! Algo salió mal al procesar tu documento. ¿Podrías intentar enviarlo de nuevo? Si el error continúa, por favor avísanos.',
              },
              context,
            );
          }
        } else {
          await this.sendAndLogMessage(
            {
              phoneNumber: from,
              message: `Recibí tu documento, pero no estaba esperando un archivo en este momento. 😊\n\n${this.getMenuMessage()}`,
            },
            context,
          );
        }
      } else {
        // Otros tipos (audio, video, etc.) -> no soportado
        await this.sendAndLogMessage(
          {
            phoneNumber: from,
            message: `Por ahora solo puedo procesar *mensajes de texto*, *fotos* e *imágenes de comprobantes* y *archivos PDF*.\n\n${this.getMenuMessage()}`,
          },
          context,
        );
      }

      // Guardar el estado final de la conversación después de procesar
      await this.saveConversationContext(context);

      return { success: true, message: 'Webhook procesado correctamente.' };
    } catch (error) {
      this.logger.error(
        `Error CRÍTICO al procesar webhook: ${error.message}`,
        error.stack,
      );
      // Considera notificar a un sistema de monitoreo aquí
      // Intentar enviar un mensaje de error genérico si es posible
      const from =
        error.context?.phoneNumber ||
        webhookData?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      if (from) {
        try {
          await this.sendAndLogMessage({
            phoneNumber: from,
            message:
              "🚨 ¡Oh no! Encontramos un error inesperado procesando tu solicitud. Ya estamos investigando. Por favor, intenta de nuevo más tarde o escribe 'Hola' para reiniciar.",
          });
        } catch (sendError) {
          this.logger.error(`Fallo al enviar mensaje de error a ${from}`);
        }
      }
      // No relanzar el error para evitar que la cola de webhooks se bloquee (depende de tu infraestructura)
      return { success: false, message: `Error interno: ${error.message}` };
    }
  }

  /**
   * Lógica principal de la conversación basada en el estado actual (cuando se recibe texto).
   */
  private async handleConversation(context: ConversationContext, text: string) {
    const { phoneNumber } = context;

    // Cancelar: regresa al menú desde cualquier estado intermedio
    if (
      this.isCancelCommand(text) &&
      context.state !== ConversationState.INITIAL &&
      context.state !== ConversationState.MENU_SELECTION
    ) {
      this.logger.log(`Usuario ${phoneNumber} canceló el flujo actual.`);
      this.resetContext(context);
      context.state = ConversationState.MENU_SELECTION;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `↩️ De acuerdo, regresamos al menú principal.\n\n${this.getMenuMessage()}`,
        },
        context,
      );
      return;
    }

    // Reinicio global: si el usuario escribe "hola" o similar en cualquier estado (excepto inicial)
    if (this.isGreeting(text) && context.state !== ConversationState.INITIAL) {
      this.logger.log(`Usuario ${phoneNumber} solicitó reiniciar conversación.`);
      this.resetContext(context);
    }

    switch (context.state) {
      case ConversationState.INITIAL:
        if (this.isGreeting(text)) {
          context.state = ConversationState.MENU_SELECTION;
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message: `👋 ¡Hola! Bienvenido al asistente de tu condominio.\n\n${this.getMenuMessage()}`,
            },
            context,
          );
        } else {
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message: `👋 ¡Hola! Soy el asistente virtual de tu condominio.\n\nEscribe *hola* para ver el menú de opciones. 😊`,
            },
            context,
          );
        }
        break;

      case ConversationState.MENU_SELECTION:
        await this.handleMenuSelection(context, text);
        break;

      // Estados del flujo de pagos (mantener lógica original)
      case ConversationState.PAYMENT_AWAITING_EMAIL:
        await this.handlePaymentEmailInput(context, text);
        break;

      case ConversationState.PAYMENT_AWAITING_DEPARTMENT:
        await this.handlePaymentDepartmentInput(context, text);
        break;

      case ConversationState.PAYMENT_AWAITING_TOWER:
        await this.handlePaymentTowerInput(context, text);
        break;

      case ConversationState.PAYMENT_AWAITING_CONDOMINIUM_SELECTION:
        await this.handlePaymentCondominiumSelection(context, text);
        break;

      case ConversationState.PAYMENT_AWAITING_CHARGE_SELECTION:
        await this.handlePaymentChargeSelection(context, text);
        break;

      case ConversationState.PAYMENT_AWAITING_FILE:
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '📎 Solo falta que me envíes tu comprobante. Puede ser una *foto* (JPG/PNG) o un *archivo PDF*, directamente en este chat.\n\n_(Si quieres cancelar, escribe *cancelar*)_',
          },
          context,
        );
        break;

      // Estados del flujo de documentos (nuevo)
      case ConversationState.DOCUMENTS_AWAITING_EMAIL:
        await this.handleDocumentsEmailInput(context, text);
        break;

      case ConversationState.DOCUMENTS_AWAITING_DEPARTMENT:
        await this.handleDocumentsDepartmentInput(context, text);
        break;

      case ConversationState.DOCUMENTS_AWAITING_TOWER:
        await this.handleDocumentsTowerInput(context, text);
        break;

      case ConversationState.DOCUMENTS_AWAITING_CONDOMINIUM_SELECTION:
        await this.handleDocumentsCondominiumSelection(context, text);
        break;

      case ConversationState.DOCUMENTS_AWAITING_DOCUMENT_SELECTION:
        await this.handleDocumentSelection(context, text);
        break;

      // Estados para estado de cuenta (nuevo flujo)
      case ConversationState.ACCOUNT_AWAITING_EMAIL:
        await this.handleAccountEmailInput(context, text);
        break;

      case ConversationState.ACCOUNT_AWAITING_DEPARTMENT:
        await this.handleAccountDepartmentInput(context, text);
        break;

      case ConversationState.ACCOUNT_AWAITING_TOWER:
        await this.handleAccountTowerInput(context, text);
        break;

      case ConversationState.ACCOUNT_MULTIPLE_CONDOMINIUMS:
        await this.handleAccountMultipleCondominiums(context, text);
        break;

      case ConversationState.ACCOUNT_AWAITING_CONDOMINIUM_SELECTION:
        await this.handleAccountCondominiumSelection(context, text);
        break;

      case ConversationState.ACCOUNT_GENERATING:
        await this.handleAccountGenerating(context);
        break;

      // Estados para registrar visita programada (opción 4)
      case ConversationState.VISIT_AWAITING_EMAIL:
        await this.handleVisitEmailInput(context, text);
        break;

      case ConversationState.VISIT_AWAITING_DEPARTMENT:
        await this.handleVisitDepartmentInput(context, text);
        break;

      case ConversationState.VISIT_AWAITING_TOWER:
        await this.handleVisitTowerInput(context, text);
        break;

      case ConversationState.VISIT_AWAITING_CONDOMINIUM_SELECTION:
        await this.handleVisitCondominiumSelection(context, text);
        break;

      case ConversationState.VISIT_AWAITING_TYPE:
        await this.handleVisitTypeInput(context, text);
        break;

      case ConversationState.VISIT_AWAITING_VISITOR_NAME:
        await this.handleVisitVisitorNameInput(context, text);
        break;

      case ConversationState.VISIT_AWAITING_ARRIVAL:
        await this.handleVisitArrivalInput(context, text);
        break;

      case ConversationState.VISIT_AWAITING_DEPARTURE:
        await this.handleVisitDepartureInput(context, text);
        break;

      case ConversationState.VISIT_AWAITING_DAYS_OF_WEEK:
        await this.handleVisitDaysOfWeekInput(context, text);
        break;

      case ConversationState.VISIT_AWAITING_DAILY_ARRIVAL:
        await this.handleVisitDailyArrivalInput(context, text);
        break;

      case ConversationState.VISIT_AWAITING_DAILY_DEPARTURE:
        await this.handleVisitDailyDepartureInput(context, text);
        break;

      case ConversationState.VISIT_AWAITING_START_DATE:
        await this.handleVisitStartDateInput(context, text);
        break;

      case ConversationState.VISIT_AWAITING_END_DATE:
        await this.handleVisitEndDateInput(context, text);
        break;

      case ConversationState.VISIT_AWAITING_VEHICLE:
        await this.handleVisitVehicleInput(context, text);
        break;

      case ConversationState.VISIT_CONFIRMING:
        await this.handleVisitConfirmation(context, text);
        break;

      case ConversationState.COMPLETED:
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `¿Hay algo más en lo que pueda ayudarte?\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        break;

      case ConversationState.ERROR:
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `Ocurrió un problema con la solicitud anterior. ¡Intentemos de nuevo!\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        break;

      default:
        this.logger.warn(`Estado desconocido ${context.state} para ${phoneNumber}`);
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `Algo inesperado ocurrió. ¡Empecemos de nuevo!\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        break;
    }
  }

  // --- Nuevas funciones para el manejo del menú ---

  private getMenuMessage(): string {
    return `¿En qué te puedo ayudar? 😊

1️⃣ Registrar comprobante de pago
2️⃣ Consultar documentos del condominio
3️⃣ Ver mi estado de cuenta
4️⃣ Registrar una visita y obtener QR

Responde con *1*, *2*, *3* o *4*.
_(En cualquier momento escribe *cancelar* para regresar aquí)_`;
  }

  private async handleMenuSelection(
    context: ConversationContext,
    text: string,
  ) {
    const option = parseInt(text.trim(), 10);
    const { phoneNumber } = context;

    switch (option) {
      case 1:
        context.state = ConversationState.PAYMENT_AWAITING_EMAIL;
        context.retryCount = 0;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '💳 *Registrar comprobante de pago*\n\nPrimero necesito verificar tu identidad.\n\n¿Cuál es tu correo electrónico registrado en la plataforma?',
          },
          context,
        );
        break;

      case 2:
        context.state = ConversationState.DOCUMENTS_AWAITING_EMAIL;
        context.retryCount = 0;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '📋 *Documentos del condominio*\n\nPrimero necesito verificar tu identidad.\n\n¿Cuál es tu correo electrónico registrado en la plataforma?',
          },
          context,
        );
        break;

      case 3:
        context.state = ConversationState.ACCOUNT_AWAITING_EMAIL;
        context.retryCount = 0;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '📊 *Estado de cuenta*\n\nPrimero necesito verificar tu identidad.\n\n¿Cuál es tu correo electrónico registrado en la plataforma?',
          },
          context,
        );
        break;

      case 4:
        context.state = ConversationState.VISIT_AWAITING_EMAIL;
        context.retryCount = 0;
        context.visitDraft = {};
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '🛎️ *Registrar visita programada*\n\nVoy a generarte un QR para que tu visita ingrese sin complicaciones. Primero necesito verificar tu identidad.\n\n¿Cuál es tu correo electrónico registrado en la plataforma?',
          },
          context,
        );
        break;

      default:
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `Hmm, no entendí esa opción 🤔\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        break;
    }
  }

  private resetContext(context: ConversationContext) {
    context.state = ConversationState.INITIAL;
    context.email = undefined;
    context.departmentNumber = undefined;
    context.tower = undefined;
    context.possibleTowers = undefined;
    context.possibleCondominiums = undefined;
    context.selectedCondominium = undefined;
    context.pendingCharges = undefined;
    context.selectedChargeIds = undefined;
    context.availableDocuments = undefined;
    context.documentKeys = undefined;
    context.visitDraft = undefined;
    context.userId = undefined;
    context.retryCount = 0;
  }

  /** Verifica si el usuario quiere cancelar y regresar al menú */
  private isCancelCommand(text: string): boolean {
    const cancelWords = ['cancelar', 'cancel', 'salir', 'exit', 'menu', 'menú', 'volver', 'regresar', 'inicio'];
    return cancelWords.some((w) => text === w);
  }

  // --- Funciones para el flujo de pagos (adaptadas del código original) ---

  private async handlePaymentEmailInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;

    if (!this.isValidEmail(text)) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '😅 Parece que hay un problema con el correo. Volvamos al menú para intentarlo de nuevo.\n\n' + this.getMenuMessage(),
          },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            `📧 Ese correo no parece válido. Asegúrate de que tenga el formato correcto, por ejemplo: *nombre@gmail.com*\n\n_(Intento ${context.retryCount} de 3 — escribe *cancelar* para salir)_`,
        },
        context,
      );
      return;
    }

    context.email = this.cleanInputKeepArroba(text);
    context.retryCount = 0;
    context.state = ConversationState.PAYMENT_AWAITING_DEPARTMENT;
    await this.sendAndLogMessage(
      {
        phoneNumber,
        message: '✉️ Perfecto. Ahora dime tu *número de departamento o casa* tal como aparece en tu contrato (ej: 101, A-3, 463).',
      },
      context,
    );
  }

  private async handlePaymentDepartmentInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;

    context.departmentNumber = text;

    try {
      const possibleCondos = await this.findUserCondominiums(
        context.phoneNumber,
        context.email,
        context.departmentNumber,
      );

      if (!possibleCondos || possibleCondos.length === 0) {
        context.retryCount = (context.retryCount ?? 0) + 1;
        if (context.retryCount >= 3) {
          this.resetContext(context);
          context.state = ConversationState.MENU_SELECTION;
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message:
                '😅 No logramos encontrar tu cuenta después de varios intentos. Verifica que el correo y número de departamento coincidan exactamente con los que tienes registrados en la plataforma.\n\nSi el problema persiste, contacta a tu administrador.\n\n' + this.getMenuMessage(),
            },
            context,
          );
          return;
        }
        context.email = undefined;
        context.departmentNumber = undefined;
        context.state = ConversationState.PAYMENT_AWAITING_EMAIL;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              `🔍 No encontré ninguna cuenta con esos datos. Puede ser un pequeño error de escritura.\n\n¿Puedes intentarlo de nuevo? Ingresa tu *correo electrónico* registrado en la plataforma.\n\n_(Intento ${context.retryCount} de 3)_`,
          },
          context,
        );
        return;
      }

      // Intento de auto-desambiguación por teléfono antes de preguntar torre.
      // - Si al menos un match tiene phone == chat, filtramos a esos (suele
      //   dejar 1 y evita preguntar torre).
      // - Si todos tienen phone distinto del chat, bloqueamos (posible intento
      //   de suplantación con email+número de otro).
      // - Si ninguno tiene phone poblado, se mantiene la lista y seguimos.
      const disambiguated = this.autoDisambiguateByPhone(possibleCondos);
      if (disambiguated.length === 0) {
        this.logger.warn(
          `[handlePaymentDept] Bloqueado por phone mismatch para ${phoneNumber}. ` +
            `Todos los matches tenían teléfono registrado y ninguno coincide con el chat.`,
        );
        context.retryCount = (context.retryCount ?? 0) + 1;
        if (context.retryCount >= 3) {
          this.resetContext(context);
          context.state = ConversationState.MENU_SELECTION;
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message: `🚫 Los datos no coinciden con el teléfono registrado. Si crees que es un error, contacta a tu administrador.\n\n${this.getMenuMessage()}`,
            },
            context,
          );
          return;
        }
        context.email = undefined;
        context.departmentNumber = undefined;
        context.state = ConversationState.PAYMENT_AWAITING_EMAIL;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `🔒 Por seguridad, los datos deben coincidir con el teléfono registrado. Vuelve a intentarlo con tu *correo electrónico* registrado.\n\n_(Intento ${context.retryCount} de 3)_`,
          },
          context,
        );
        return;
      }
      const matches = disambiguated;

      // Detectar ambigüedad por torre sobre los matches ya filtrados por phone.
      const ambiguousTowers = this.detectTowerAmbiguity(matches);
      if (ambiguousTowers.length > 0) {
        context.possibleCondominiums = matches;
        context.possibleTowers = ambiguousTowers;
        context.retryCount = 0;
        context.state = ConversationState.PAYMENT_AWAITING_TOWER;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: this.formatTowerOptionsMessage(ambiguousTowers),
          },
          context,
        );
        return;
      }

      if (matches.length === 1) {
        // Única coincidencia: fijamos userId directamente.
        context.userId = matches[0].userId;
        context.selectedCondominium = matches[0];
        context.retryCount = 0;
        context.state = ConversationState.PAYMENT_AWAITING_CHARGE_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `✅ ¡Te encontré! Estás en *${matches[0].condominiumName || matches[0].condominiumId}*.\n\nBuscando tus cargos pendientes... ⏳`,
          },
          context,
        );
        await this.showPendingCharges(context);
      } else {
        // NO fijamos userId aquí: el usuario debe elegir explícitamente para
        // evitar aplicar pagos/consultas al residente equivocado cuando hay
        // duplicados indistinguibles por email+number (el handler de selección
        // de condominio fija context.userId con el de la opción elegida).
        context.userId = undefined;
        context.possibleCondominiums = matches;
        context.state =
          ConversationState.PAYMENT_AWAITING_CONDOMINIUM_SELECTION;
        await this.showCondominiumOptions(context, matches);
      }
    } catch (error) {
      this.logger.error(
        `❌ [handlePaymentDept] Error buscando condominios para pagos en ${phoneNumber}: ${error.message}`,
        error.stack,
      );
      this.logger.error(
        `❌ [handlePaymentDept] Datos usados - email: "${context.email}", dept: "${context.departmentNumber}", phone: "${phoneNumber}"`,
      );
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '😥 Hubo un problema buscando tu información. Por favor, intenta de nuevo más tarde escribiendo "Hola".',
        },
        context,
      );
    }
  }

  /**
   * Maneja la respuesta del usuario cuando el bot detectó ambigüedad de torre
   * (mismo email+número de depto en más de una torre) dentro del flujo de pagos.
   */
  private async handlePaymentTowerInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;

    if (
      !context.possibleTowers ||
      context.possibleTowers.length === 0 ||
      !context.possibleCondominiums
    ) {
      this.logger.warn(
        `[handlePaymentTower] Estado inconsistente para ${phoneNumber}. Reiniciando.`,
      );
      this.resetContext(context);
      context.state = ConversationState.MENU_SELECTION;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `😅 Se perdió el contexto. Empecemos de nuevo.\n\n${this.getMenuMessage()}`,
        },
        context,
      );
      return;
    }

    const resolved = this.resolveTowerFromInput(text, context.possibleTowers);
    if (!resolved) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `😅 No logré identificar la torre después de varios intentos. Volvamos al menú.\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `🤔 No reconocí esa torre. Responde con el *número* o el *nombre exacto*:\n\n${context.possibleTowers
            .map((t, i) => `${i + 1}. ${t}`)
            .join('\n')}\n\n_(Intento ${context.retryCount} de 3)_`,
        },
        context,
      );
      return;
    }

    context.tower = resolved;
    const filtered = context.possibleCondominiums.filter(
      (m) =>
        m.tower && this.cleanInput(String(m.tower)) === this.cleanInput(resolved),
    );

    if (filtered.length === 0) {
      // No debería ocurrir: las torres se calculan desde possibleCondominiums.
      this.logger.error(
        `[handlePaymentTower] Torre "${resolved}" resuelta pero sin coincidencias en possibleCondominiums.`,
      );
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '😥 Hubo un problema filtrando por torre. Escribe "Hola" para reiniciar.',
        },
        context,
      );
      return;
    }

    // Validación estricta de pertenencia: si el usuario de la torre elegida
    // tiene teléfono registrado y no coincide con el del chat, se rechaza.
    // Los residentes sin phone poblado en BD quedan exentos (condominios donde
    // el admin no ha poblado el campo).
    const phoneConflict = filtered.every(
      (m) => m.phoneInDB === true && m.phoneMatches !== true,
    );
    if (phoneConflict) {
      this.logger.warn(
        `[handlePaymentTower] Rechazado: torre "${resolved}" pertenece a otro teléfono (${phoneNumber}).`,
      );
      this.resetContext(context);
      context.state = ConversationState.MENU_SELECTION;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `🚫 Esa torre no está asociada a tu teléfono. Por seguridad no puedo continuar. Si crees que es un error, contacta a tu administrador.\n\n${this.getMenuMessage()}`,
        },
        context,
      );
      return;
    }

    context.retryCount = 0;
    context.possibleTowers = undefined;
    // Solo fijamos userId cuando la torre filtra a un único match. Si quedan
    // varios (caso residual: mismo condo+torre con 2 userIds), delegamos en
    // showCondominiumOptions para que el usuario elija explícitamente.
    if (filtered.length === 1) {
      context.userId = filtered[0].userId;
    } else {
      context.userId = undefined;
    }

    if (filtered.length === 1) {
      context.selectedCondominium = filtered[0];
      context.possibleCondominiums = undefined;
      context.state = ConversationState.PAYMENT_AWAITING_CHARGE_SELECTION;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `✅ ¡Te encontré! Estás en *${filtered[0].condominiumName || filtered[0].condominiumId}*, torre *${resolved}*.\n\nBuscando tus cargos pendientes... ⏳`,
        },
        context,
      );
      await this.showPendingCharges(context);
    } else {
      context.possibleCondominiums = filtered;
      context.state = ConversationState.PAYMENT_AWAITING_CONDOMINIUM_SELECTION;
      await this.showCondominiumOptions(context, filtered);
    }
  }

  private async handlePaymentCondominiumSelection(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    const index = parseInt(text, 10);

    if (
      isNaN(index) ||
      !context.possibleCondominiums ||
      index < 1 ||
      index > context.possibleCondominiums.length
    ) {
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '🚫 Opción inválida. Por favor, escribe solo el número correspondiente a uno de los condominios de la lista.',
        },
        context,
      );
      return;
    }

    const selected = context.possibleCondominiums[index - 1];
    context.selectedCondominium = selected;
    // Aseguramos que el userId corresponda al condo seleccionado
    // (cada condominio tiene un documento de usuario distinto).
    if (selected.userId) context.userId = selected.userId;
    if (selected.tower) context.tower = selected.tower;
    context.state = ConversationState.PAYMENT_AWAITING_CHARGE_SELECTION;

    await this.sendAndLogMessage(
      {
        phoneNumber,
        message: `✔️ Seleccionado: ${selected.condominiumName || selected.condominiumId}. Ahora buscaré tus cargos pendientes...`,
      },
      context,
    );
    await this.showPendingCharges(context);
  }

  private async handlePaymentChargeSelection(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;

    if (!context.pendingCharges || context.pendingCharges.length === 0) {
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            'Parece que no tienes cargos pendientes. Si quieres adjuntar tu comprobante, envíalo ahora. Si no, escribe "Hola" para empezar de nuevo.',
        },
        context,
      );
      context.state = ConversationState.INITIAL;
      return;
    }

    const selectedIndexes = text.split(',').map((s) => parseInt(s.trim(), 10));
    const validIndexes = selectedIndexes.filter((idx) => !isNaN(idx));

    if (validIndexes.length === 0 || selectedIndexes.some(isNaN)) {
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '🤔 Formato incorrecto. Por favor, ingresa solo los números de los cargos que quieres pagar, separados por comas si son varios (ej: "1" o "1, 3").',
        },
        context,
      );
      return;
    }

    const selectedIds: string[] = [];
    const invalidSelections: number[] = [];

    validIndexes.forEach((idxNum) => {
      const foundCharge = context.pendingCharges?.find(
        (c) => c.index === idxNum,
      );
      if (foundCharge) {
        selectedIds.push(foundCharge.id);
      } else {
        invalidSelections.push(idxNum);
      }
    });

    if (invalidSelections.length > 0) {
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `⚠️ Los números ${invalidSelections.join(', ')} no corresponden a ningún cargo de la lista. Por favor, revisa los números.`,
        },
        context,
      );
      return;
    }

    if (selectedIds.length === 0) {
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '❌ No seleccionaste ningún cargo válido. Por favor, elige al menos un número de la lista.',
        },
        context,
      );
      return;
    }

    context.selectedChargeIds = selectedIds;
    context.state = ConversationState.PAYMENT_AWAITING_FILE;
    await this.sendAndLogMessage(
      {
        phoneNumber,
        message:
          '📝 ¡Excelente! Ya seleccionaste los cargos. Ahora, por favor, adjunta tu comprobante de pago. Puede ser una imagen (JPG/PNG) o un archivo PDF. ¡Solo envíalo directamente aquí!',
      },
      context,
    );
  }

  // --- Funciones para el flujo de documentos (nuevo) ---

  private async handleDocumentsEmailInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;

    if (!this.isValidEmail(text)) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          { phoneNumber, message: '😅 Parece que hay un problema con el correo. Volvamos al menú.\n\n' + this.getMenuMessage() },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `📧 Ese correo no parece válido. Debe tener el formato *nombre@dominio.com*\n\n_(Intento ${context.retryCount} de 3 — escribe *cancelar* para salir)_`,
        },
        context,
      );
      return;
    }

    context.email = this.cleanInputKeepArroba(text);
    context.retryCount = 0;
    context.state = ConversationState.DOCUMENTS_AWAITING_DEPARTMENT;
    await this.sendAndLogMessage(
      { phoneNumber, message: '✉️ Perfecto. Ahora dime tu *número de departamento o casa* (ej: 101, A-3, 463).' },
      context,
    );
  }

  private async handleDocumentsDepartmentInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;

    context.departmentNumber = text;

    try {
      const possibleCondos = await this.findUserCondominiums(
        context.phoneNumber,
        context.email,
        context.departmentNumber,
      );

      if (!possibleCondos || possibleCondos.length === 0) {
        context.retryCount = (context.retryCount ?? 0) + 1;
        if (context.retryCount >= 3) {
          this.resetContext(context);
          context.state = ConversationState.MENU_SELECTION;
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message: '😅 No logramos encontrar tu cuenta. Verifica que el correo y número de departamento sean exactamente los que tienes en la plataforma.\n\n' + this.getMenuMessage(),
            },
            context,
          );
          return;
        }
        context.email = undefined;
        context.departmentNumber = undefined;
        context.state = ConversationState.DOCUMENTS_AWAITING_EMAIL;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `🔍 No encontré ninguna cuenta con esos datos. Puede ser un pequeño error de escritura.\n\n¿Puedes intentarlo de nuevo? Ingresa tu *correo electrónico* registrado.\n\n_(Intento ${context.retryCount} de 3)_`,
          },
          context,
        );
        return;
      }

      const disambiguated = this.autoDisambiguateByPhone(possibleCondos);
      if (disambiguated.length === 0) {
        this.logger.warn(
          `[handleDocumentsDept] Bloqueado por phone mismatch para ${phoneNumber}.`,
        );
        context.retryCount = (context.retryCount ?? 0) + 1;
        if (context.retryCount >= 3) {
          this.resetContext(context);
          context.state = ConversationState.MENU_SELECTION;
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message: `🚫 Los datos no coinciden con el teléfono registrado. Si crees que es un error, contacta a tu administrador.\n\n${this.getMenuMessage()}`,
            },
            context,
          );
          return;
        }
        context.email = undefined;
        context.departmentNumber = undefined;
        context.state = ConversationState.DOCUMENTS_AWAITING_EMAIL;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `🔒 Por seguridad, los datos deben coincidir con el teléfono registrado. Vuelve a intentarlo con tu *correo electrónico* registrado.\n\n_(Intento ${context.retryCount} de 3)_`,
          },
          context,
        );
        return;
      }
      const matches = disambiguated;

      const ambiguousTowers = this.detectTowerAmbiguity(matches);
      if (ambiguousTowers.length > 0) {
        context.possibleCondominiums = matches;
        context.possibleTowers = ambiguousTowers;
        context.retryCount = 0;
        context.state = ConversationState.DOCUMENTS_AWAITING_TOWER;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: this.formatTowerOptionsMessage(ambiguousTowers),
          },
          context,
        );
        return;
      }

      if (matches.length === 1) {
        context.userId = matches[0].userId;
        context.selectedCondominium = matches[0];
        context.retryCount = 0;
        context.state = ConversationState.DOCUMENTS_AWAITING_DOCUMENT_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `✅ ¡Te encontré! Estás en *${matches[0].condominiumName || matches[0].condominiumId}*.\n\nBuscando documentos disponibles... 📋`,
          },
          context,
        );
        await this.showAvailableDocuments(context);
      } else {
        context.userId = undefined;
        context.possibleCondominiums = matches;
        context.state =
          ConversationState.DOCUMENTS_AWAITING_CONDOMINIUM_SELECTION;
        await this.showCondominiumOptions(context, matches);
      }
    } catch (error) {
      this.logger.error(
        `❌ [handleDocumentsDept] Error buscando condominios para documentos en ${phoneNumber}: ${error.message}`,
        error.stack,
      );
      this.logger.error(
        `❌ [handleDocumentsDept] Datos usados - email: "${context.email}", dept: "${context.departmentNumber}", phone: "${phoneNumber}"`,
      );
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '😥 Ocurrió un problema al buscar tu información. Intenta nuevamente escribiendo "Hola".',
        },
        context,
      );
    }
  }

  private async handleDocumentsTowerInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;

    if (
      !context.possibleTowers ||
      context.possibleTowers.length === 0 ||
      !context.possibleCondominiums
    ) {
      this.resetContext(context);
      context.state = ConversationState.MENU_SELECTION;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `😅 Se perdió el contexto. Empecemos de nuevo.\n\n${this.getMenuMessage()}`,
        },
        context,
      );
      return;
    }

    const resolved = this.resolveTowerFromInput(text, context.possibleTowers);
    if (!resolved) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `😅 No logré identificar la torre. Volvamos al menú.\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `🤔 No reconocí esa torre. Responde con el *número* o el *nombre exacto*:\n\n${context.possibleTowers
            .map((t, i) => `${i + 1}. ${t}`)
            .join('\n')}\n\n_(Intento ${context.retryCount} de 3)_`,
        },
        context,
      );
      return;
    }

    context.tower = resolved;
    const filtered = context.possibleCondominiums.filter(
      (m) =>
        m.tower && this.cleanInput(String(m.tower)) === this.cleanInput(resolved),
    );

    if (filtered.length === 0) {
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '😥 Hubo un problema filtrando por torre. Escribe "Hola" para reiniciar.',
        },
        context,
      );
      return;
    }

    const phoneConflict = filtered.every(
      (m) => m.phoneInDB === true && m.phoneMatches !== true,
    );
    if (phoneConflict) {
      this.logger.warn(
        `[handleDocumentsTower] Rechazado: torre "${resolved}" pertenece a otro teléfono (${phoneNumber}).`,
      );
      this.resetContext(context);
      context.state = ConversationState.MENU_SELECTION;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `🚫 Esa torre no está asociada a tu teléfono. Por seguridad no puedo continuar. Si crees que es un error, contacta a tu administrador.\n\n${this.getMenuMessage()}`,
        },
        context,
      );
      return;
    }

    context.retryCount = 0;
    context.possibleTowers = undefined;
    // Solo fijamos userId cuando la torre filtra a un único match. Si quedan
    // varios (caso residual: mismo condo+torre con 2 userIds), delegamos en
    // showCondominiumOptions para que el usuario elija explícitamente.
    if (filtered.length === 1) {
      context.userId = filtered[0].userId;
    } else {
      context.userId = undefined;
    }

    if (filtered.length === 1) {
      context.selectedCondominium = filtered[0];
      context.possibleCondominiums = undefined;
      context.state = ConversationState.DOCUMENTS_AWAITING_DOCUMENT_SELECTION;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `✅ ¡Te encontré! Estás en *${filtered[0].condominiumName || filtered[0].condominiumId}*, torre *${resolved}*.\n\nBuscando documentos disponibles... 📋`,
        },
        context,
      );
      await this.showAvailableDocuments(context);
    } else {
      context.possibleCondominiums = filtered;
      context.state =
        ConversationState.DOCUMENTS_AWAITING_CONDOMINIUM_SELECTION;
      await this.showCondominiumOptions(context, filtered);
    }
  }

  private async handleDocumentsCondominiumSelection(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    const index = parseInt(text, 10);

    if (
      isNaN(index) ||
      !context.possibleCondominiums ||
      index < 1 ||
      index > context.possibleCondominiums.length
    ) {
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '🚫 Opción no válida. Escribe el número correspondiente al condominio de la lista.',
        },
        context,
      );
      return;
    }

    const selected = context.possibleCondominiums[index - 1];
    context.selectedCondominium = selected;
    if (selected.userId) context.userId = selected.userId;
    if (selected.tower) context.tower = selected.tower;
    context.state = ConversationState.DOCUMENTS_AWAITING_DOCUMENT_SELECTION;

    await this.sendAndLogMessage(
      {
        phoneNumber,
        message: `✔️ Seleccionado: ${selected.condominiumName || selected.condominiumId}. Consultando documentos disponibles...`,
      },
      context,
    );
    await this.showAvailableDocuments(context);
  }

  private async showAvailableDocuments(context: ConversationContext) {
    const { phoneNumber, selectedCondominium } = context;

    if (!selectedCondominium) {
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: '❌ Error interno. Escribe "Hola" para reiniciar.',
        },
        context,
      );
      return;
    }

    try {
      const { clientId, condominiumId } = selectedCondominium;
      const documents = await this.publicDocumentsService.getPublicDocuments(
        clientId,
        condominiumId,
      );

      if (!documents) {
        context.state = ConversationState.COMPLETED;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '📄 Lo siento, no hay documentos públicos disponibles para tu condominio en este momento. Si necesitas algo más, escribe "Hola".',
          },
          context,
        );
        return;
      }

      context.availableDocuments = documents;
      const { text, documentKeys } =
        this.publicDocumentsService.formatDocumentsList(documents);
      context.documentKeys = documentKeys;

      if (documentKeys.length === 0) {
        context.state = ConversationState.COMPLETED;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: text,
          },
          context,
        );
        return;
      }

      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: text,
        },
        context,
      );
    } catch (error) {
      this.logger.error(
        `Error obteniendo documentos para ${phoneNumber}: ${error.message}`,
        error.stack,
      );
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '😥 Hubo un problema obteniendo los documentos. Intenta nuevamente escribiendo "Hola".',
        },
        context,
      );
    }
  }

  private async handleDocumentSelection(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    const selection = parseInt(text.trim(), 10);

    if (!context.documentKeys || !context.availableDocuments) {
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: '❌ Error interno. Escribe "Hola" para reiniciar.',
        },
        context,
      );
      return;
    }

    if (
      isNaN(selection) ||
      selection < 1 ||
      selection > context.documentKeys.length
    ) {
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `🤔 Opción no válida. Por favor, responde con un número del 1 al ${context.documentKeys.length}.`,
        },
        context,
      );
      return;
    }

    const selectedKey = context.documentKeys[selection - 1];
    const document = this.publicDocumentsService.getDocumentByKey(
      context.availableDocuments,
      selectedKey,
    );

    if (!document) {
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '❌ No pude encontrar el documento seleccionado. Escribe "Hola" para reiniciar.',
        },
        context,
      );
      return;
    }

    try {
      // Validar que la URL del documento sea accesible
      const isUrlValid = await this.publicDocumentsService.validateDocumentUrl(
        document.fileUrl,
      );

      if (!isUrlValid) {
        this.logger.warn(`URL del documento no accesible: ${document.fileUrl}`);
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '😥 El documento solicitado no está disponible temporalmente. Por favor, intenta más tarde o contacta al administrador.',
          },
          context,
        );
        return;
      }

      // Intentar enviar el documento directamente
      const result = await this.sendDocumentMessage(
        phoneNumber,
        document,
        context,
      );

      if (result.success) {
        context.state = ConversationState.COMPLETED;

        // Mensaje adicional de confirmación
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '🎉 ¡Listo! Si necesitas otro documento o algo más, simplemente escribe "Hola" para ver el menú nuevamente.',
          },
          context,
        );
      } else {
        // Si falló tanto el envío directo como la URL acortada
        context.state = ConversationState.ERROR;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '😥 Ocurrió un error al enviar el documento. Por favor, intenta nuevamente escribiendo "Hola".',
          },
          context,
        );
      }
    } catch (error) {
      this.logger.error(
        `Error procesando documento para ${phoneNumber}: ${error.message}`,
        error.stack,
      );
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '😥 Ocurrió un error al procesar tu solicitud. Escribe "Hola" para intentar de nuevo.',
        },
        context,
      );
    }
  }

  // --- Funciones para el flujo de estado de cuenta (nuevo) ---

  private async handleAccountEmailInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;

    if (!this.isValidEmail(text)) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          { phoneNumber, message: '😅 Parece que hay un problema con el correo. Volvamos al menú.\n\n' + this.getMenuMessage() },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `📧 Ese correo no parece válido. Debe tener el formato *nombre@dominio.com*\n\n_(Intento ${context.retryCount} de 3 — escribe *cancelar* para salir)_`,
        },
        context,
      );
      return;
    }

    context.email = this.cleanInputKeepArroba(text);
    context.retryCount = 0;
    context.state = ConversationState.ACCOUNT_AWAITING_DEPARTMENT;
    await this.sendAndLogMessage(
      { phoneNumber, message: '✉️ Perfecto. Ahora dime tu *número de departamento o casa* (ej: 101, A-3, 463).' },
      context,
    );
  }

  private async handleAccountDepartmentInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;

    context.departmentNumber = text;

    try {
      const possibleCondos = await this.findUserCondominiums(
        context.phoneNumber,
        context.email,
        context.departmentNumber,
      );

      if (!possibleCondos || possibleCondos.length === 0) {
        context.retryCount = (context.retryCount ?? 0) + 1;
        if (context.retryCount >= 3) {
          this.resetContext(context);
          context.state = ConversationState.MENU_SELECTION;
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message: '😅 No logramos encontrar tu cuenta. Verifica que el correo y número de departamento sean exactamente los que tienes en la plataforma.\n\n' + this.getMenuMessage(),
            },
            context,
          );
          return;
        }
        context.email = undefined;
        context.departmentNumber = undefined;
        context.state = ConversationState.ACCOUNT_AWAITING_EMAIL;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `🔍 No encontré ninguna cuenta con esos datos. Puede ser un pequeño error de escritura.\n\n¿Puedes intentarlo de nuevo? Ingresa tu *correo electrónico* registrado.\n\n_(Intento ${context.retryCount} de 3)_`,
          },
          context,
        );
        return;
      }

      const disambiguated = this.autoDisambiguateByPhone(possibleCondos);
      if (disambiguated.length === 0) {
        this.logger.warn(
          `[handleAccountDept] Bloqueado por phone mismatch para ${phoneNumber}.`,
        );
        context.retryCount = (context.retryCount ?? 0) + 1;
        if (context.retryCount >= 3) {
          this.resetContext(context);
          context.state = ConversationState.MENU_SELECTION;
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message: `🚫 Los datos no coinciden con el teléfono registrado. Si crees que es un error, contacta a tu administrador.\n\n${this.getMenuMessage()}`,
            },
            context,
          );
          return;
        }
        context.email = undefined;
        context.departmentNumber = undefined;
        context.state = ConversationState.ACCOUNT_AWAITING_EMAIL;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `🔒 Por seguridad, los datos deben coincidir con el teléfono registrado. Vuelve a intentarlo con tu *correo electrónico* registrado.\n\n_(Intento ${context.retryCount} de 3)_`,
          },
          context,
        );
        return;
      }
      const matches = disambiguated;

      const ambiguousTowers = this.detectTowerAmbiguity(matches);
      if (ambiguousTowers.length > 0) {
        context.possibleCondominiums = matches;
        context.possibleTowers = ambiguousTowers;
        context.retryCount = 0;
        context.state = ConversationState.ACCOUNT_AWAITING_TOWER;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: this.formatTowerOptionsMessage(ambiguousTowers),
          },
          context,
        );
        return;
      }

      if (matches.length === 1) {
        context.userId = matches[0].userId;
        context.selectedCondominium = matches[0];
        context.retryCount = 0;
        context.state = ConversationState.ACCOUNT_GENERATING;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `✅ ¡Te encontré! Estás en *${matches[0].condominiumName || matches[0].condominiumId}*.\n\nGenerando tu estado de cuenta, un momento... 📊`,
          },
          context,
        );
        await this.handleAccountGenerating(context);
      } else {
        context.userId = undefined;
        context.possibleCondominiums = matches;
        context.state =
          ConversationState.ACCOUNT_AWAITING_CONDOMINIUM_SELECTION;
        await this.showCondominiumOptions(context, matches);
      }
    } catch (error) {
      this.logger.error(
        `❌ [handleAccountDept] Error buscando condominios para estado de cuenta en ${phoneNumber}: ${error.message}`,
        error.stack,
      );
      this.logger.error(
        `❌ [handleAccountDept] Datos usados - email: "${context.email}", dept: "${context.departmentNumber}", phone: "${phoneNumber}"`,
      );
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '😥 Ocurrió un problema al buscar tu información. Intenta nuevamente escribiendo "Hola".',
        },
        context,
      );
    }
  }

  private async handleAccountMultipleCondominiums(
    context: ConversationContext,
    text: string,
  ) {
    // Esta función puede ser similar a handleAccountCondominiumSelection
    await this.handleAccountCondominiumSelection(context, text);
  }

  private async handleAccountTowerInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;

    if (
      !context.possibleTowers ||
      context.possibleTowers.length === 0 ||
      !context.possibleCondominiums
    ) {
      this.resetContext(context);
      context.state = ConversationState.MENU_SELECTION;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `😅 Se perdió el contexto. Empecemos de nuevo.\n\n${this.getMenuMessage()}`,
        },
        context,
      );
      return;
    }

    const resolved = this.resolveTowerFromInput(text, context.possibleTowers);
    if (!resolved) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `😅 No logré identificar la torre. Volvamos al menú.\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `🤔 No reconocí esa torre. Responde con el *número* o el *nombre exacto*:\n\n${context.possibleTowers
            .map((t, i) => `${i + 1}. ${t}`)
            .join('\n')}\n\n_(Intento ${context.retryCount} de 3)_`,
        },
        context,
      );
      return;
    }

    context.tower = resolved;
    const filtered = context.possibleCondominiums.filter(
      (m) =>
        m.tower && this.cleanInput(String(m.tower)) === this.cleanInput(resolved),
    );

    if (filtered.length === 0) {
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '😥 Hubo un problema filtrando por torre. Escribe "Hola" para reiniciar.',
        },
        context,
      );
      return;
    }

    const phoneConflict = filtered.every(
      (m) => m.phoneInDB === true && m.phoneMatches !== true,
    );
    if (phoneConflict) {
      this.logger.warn(
        `[handleAccountTower] Rechazado: torre "${resolved}" pertenece a otro teléfono (${phoneNumber}).`,
      );
      this.resetContext(context);
      context.state = ConversationState.MENU_SELECTION;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `🚫 Esa torre no está asociada a tu teléfono. Por seguridad no puedo continuar. Si crees que es un error, contacta a tu administrador.\n\n${this.getMenuMessage()}`,
        },
        context,
      );
      return;
    }

    context.retryCount = 0;
    context.possibleTowers = undefined;
    // Solo fijamos userId cuando la torre filtra a un único match. Si quedan
    // varios (caso residual: mismo condo+torre con 2 userIds), delegamos en
    // showCondominiumOptions para que el usuario elija explícitamente.
    if (filtered.length === 1) {
      context.userId = filtered[0].userId;
    } else {
      context.userId = undefined;
    }

    if (filtered.length === 1) {
      context.selectedCondominium = filtered[0];
      context.possibleCondominiums = undefined;
      context.state = ConversationState.ACCOUNT_GENERATING;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `✅ ¡Te encontré! Estás en *${filtered[0].condominiumName || filtered[0].condominiumId}*, torre *${resolved}*.\n\nGenerando tu estado de cuenta, un momento... 📊`,
        },
        context,
      );
      await this.handleAccountGenerating(context);
    } else {
      context.possibleCondominiums = filtered;
      context.state =
        ConversationState.ACCOUNT_AWAITING_CONDOMINIUM_SELECTION;
      await this.showCondominiumOptions(context, filtered);
    }
  }

  private async handleAccountCondominiumSelection(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    const index = parseInt(text, 10);

    if (
      isNaN(index) ||
      !context.possibleCondominiums ||
      index < 1 ||
      index > context.possibleCondominiums.length
    ) {
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '🚫 Opción no válida. Escribe el número correspondiente al condominio de la lista.',
        },
        context,
      );
      return;
    }

    const selected = context.possibleCondominiums[index - 1];
    context.selectedCondominium = selected;
    if (selected.userId) context.userId = selected.userId;
    if (selected.tower) context.tower = selected.tower;
    context.state = ConversationState.ACCOUNT_GENERATING;

    await this.sendAndLogMessage(
      {
        phoneNumber,
        message: `✔️ Seleccionado: ${selected.condominiumName || selected.condominiumId}. Generando tu estado de cuenta... 📄`,
      },
      context,
    );
    await this.handleAccountGenerating(context);
  }

  private async handleAccountGenerating(context: ConversationContext) {
    const {
      phoneNumber,
      selectedCondominium,
      userId,
      email,
      departmentNumber,
    } = context;

    if (!selectedCondominium || !userId || !email || !departmentNumber) {
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: '❌ Error interno. Escribe "Hola" para reiniciar.',
        },
        context,
      );
      return;
    }

    try {
      const { clientId, condominiumId } = selectedCondominium;

      // Obtener datos de la cuenta
      const accountData = await this.accountStatementService.getAccountData(
        clientId,
        condominiumId,
        userId,
      );

      if (
        accountData.charges.length === 0 &&
        accountData.payments.length === 0
      ) {
        context.state = ConversationState.COMPLETED;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '📄 No se encontraron cargos ni pagos registrados en tu cuenta en este momento. Si necesitas algo más, escribe "Hola".',
          },
          context,
        );
        return;
      }

      // Obtener información del usuario desde el primer cargo o pago
      const userName =
        accountData.charges.length > 0
          ? accountData.charges[0].name
          : 'Usuario';

      // Obtener información adicional del usuario desde Firestore (incluyendo lastName)
      let userFullName = userName;
      try {
        const userDocRef = this.firestore.doc(
          `clients/${clientId}/condominiums/${condominiumId}/users/${userId}`,
        );
        const userDoc = await userDocRef.get();

        if (userDoc.exists) {
          const userData = userDoc.data();
          const firstName = userData.name || userName;
          const lastName = userData.lastName || '';
          userFullName = lastName ? `${firstName} ${lastName}` : firstName;
        }
      } catch (userError) {
        this.logger.warn(
          `No se pudo obtener lastName del usuario ${userId}: ${userError.message}`,
        );
        // Mantener solo el nombre original si hay error
      }

      const userInfo = {
        name: userFullName,
        email: email,
        departmentNumber: departmentNumber,
        condominiumName: selectedCondominium.condominiumName,
      };

      // Generar PDF
      const pdfBuffer =
        await this.accountStatementService.generateAccountStatementPDF(
          accountData,
          userInfo,
        );

      // Enviar PDF como documento
      const result = await this.sendAccountStatementPDF(
        phoneNumber,
        pdfBuffer,
        context,
      );

      if (result.success) {
        context.state = ConversationState.COMPLETED;

        // Mensaje adicional de confirmación
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '🎉 ¡Listo! Tu estado de cuenta ha sido generado y enviado. Si necesitas algo más, simplemente escribe "Hola" para ver el menú.',
          },
          context,
        );
      } else {
        context.state = ConversationState.ERROR;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '😥 Ocurrió un error al enviar tu estado de cuenta. Por favor, intenta nuevamente escribiendo "Hola".',
          },
          context,
        );
      }
    } catch (error) {
      this.logger.error(
        `Error generando estado de cuenta para ${phoneNumber}: ${error.message}`,
        error.stack,
      );
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '😥 Ocurrió un error al generar tu estado de cuenta. Escribe "Hola" para intentar de nuevo.',
        },
        context,
      );
    }
  }

  /**
   * Envía un PDF de estado de cuenta por WhatsApp
   */
  private async sendAccountStatementPDF(
    phoneNumber: string,
    pdfBuffer: Buffer,
    context?: ConversationContext,
  ): Promise<{ success: boolean; message: string }> {
    try {
      this.logger.log(
        `Enviando estado de cuenta PDF a ${phoneNumber}, tamaño: ${pdfBuffer.length} bytes`,
      );

      // Subir el PDF a Firebase Storage
      const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
      if (!bucketName) {
        throw new Error('FIREBASE_STORAGE_BUCKET no está configurado');
      }

      const bucket = admin.storage().bucket(bucketName);
      const fileName = `estado_cuenta_${Date.now()}.pdf`;
      const filePath = `temp/account-statements/${fileName}`;
      const file = bucket.file(filePath);

      // Subir el archivo
      await file.save(pdfBuffer, {
        metadata: { contentType: 'application/pdf' },
      });

      // Hacer el archivo público temporalmente
      await file.makePublic();
      const publicUrl = `https://storage.googleapis.com/${bucketName}/${filePath}`;

      this.logger.log(`PDF subido temporalmente: ${publicUrl}`);

      // NUEVA IMPLEMENTACIÓN: Guardar información para eliminación automática
      await this.scheduleFileForDeletion(filePath, bucketName);

      // ... resto del código de envío de WhatsApp ...

      const apiUrl = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phoneNumber.replace(/^\+/, ''),
        type: 'document',
        document: {
          link: publicUrl,
          filename: fileName,
          caption: 'Tu estado de cuenta está listo 📄',
        },
      };

      // CRÍTICO: Enviar el documento a través de WhatsApp API
      const response = await axios.post(apiUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        },
      });

      // Registrar en auditoría
      await this.logToAudit(
        context || null,
        'out',
        {
          type: 'account_statement',
          fileName: fileName,
        },
        { phoneNumber },
      );

      this.logger.log(`Estado de cuenta enviado exitosamente a ${phoneNumber}`);
      return {
        success: true,
        message: 'Estado de cuenta enviado correctamente.',
      };
    } catch (error) {
      this.logger.error(
        `Error enviando estado de cuenta a ${phoneNumber}: ${error.message}`,
        error.stack,
      );

      if (error.response) {
        this.logger.error('WhatsApp API error data:', error.response.data);
      }

      return {
        success: false,
        message: `Error al enviar estado de cuenta: ${error.message}`,
      };
    }
  }

  /**
   * Programa un archivo para eliminación automática
   * NUEVO: Tiempo reducido a 10 minutos para optimizar recursos del servidor
   */
  private async scheduleFileForDeletion(
    filePath: string,
    bucketName: string,
  ): Promise<void> {
    try {
      const deletionTime = new Date();
      deletionTime.setMinutes(deletionTime.getMinutes() + 10); // Reducido de 30 a 10 minutos

      const scheduleData = {
        filePath,
        bucketName,
        scheduledDeletionTime: admin.firestore.Timestamp.fromDate(deletionTime),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'pending',
      };

      await this.firestore
        .collection('scheduledFileDeletions')
        .add(scheduleData);

      this.logger.log(
        `Archivo programado para eliminación automática en 10 minutos: ${filePath}`,
      );
    } catch (error) {
      this.logger.error(
        `Error programando eliminación de archivo: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Job que se ejecuta cada 5 minutos para eliminar archivos temporales vencidos
   * NUEVO: Método robusto y persistente para limpieza automática
   */
  @Cron('0 */5 * * * *') // Cada 5 minutos
  async cleanupExpiredFiles(): Promise<void> {
    try {
      const now = admin.firestore.Timestamp.now();

      // Buscar archivos programados para eliminación que ya vencieron
      const expiredFilesSnapshot = await this.firestore
        .collection('scheduledFileDeletions')
        .where('scheduledDeletionTime', '<=', now)
        .where('status', '==', 'pending')
        .limit(20) // Procesar máximo 20 archivos por vez para no sobrecargar
        .get();

      if (expiredFilesSnapshot.empty) {
        this.logger.debug('No hay archivos temporales para eliminar');
        return;
      }

      this.logger.log(
        `Procesando ${expiredFilesSnapshot.size} archivos temporales para eliminación`,
      );

      const batch = this.firestore.batch();
      let deletedCount = 0;
      let errorCount = 0;

      for (const doc of expiredFilesSnapshot.docs) {
        const data = doc.data();
        const { filePath, bucketName } = data;

        try {
          // Eliminar el archivo de Firebase Storage
          const bucket = admin.storage().bucket(bucketName);
          const file = bucket.file(filePath);

          // Verificar si el archivo existe antes de intentar eliminarlo
          const [exists] = await file.exists();
          if (exists) {
            await file.delete();
            this.logger.log(`Archivo temporal eliminado: ${filePath}`);
          } else {
            this.logger.warn(`Archivo ya no existe: ${filePath}`);
          }

          // Marcar como completado en batch
          batch.update(doc.ref, {
            status: 'completed',
            deletedAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          deletedCount++;
        } catch (deleteError) {
          this.logger.error(
            `Error eliminando archivo ${filePath}: ${deleteError.message}`,
          );

          // Marcar como error en batch
          batch.update(doc.ref, {
            status: 'error',
            errorMessage: deleteError.message,
            lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
          });

          errorCount++;
        }
      }

      // Ejecutar todas las actualizaciones en batch
      await batch.commit();

      this.logger.log(
        `Limpieza completada: ${deletedCount} archivos eliminados, ${errorCount} errores`,
      );

      // Limpiar registros antiguos completados (mayores a 24 horas)
      await this.cleanupOldDeletionRecords();
    } catch (error) {
      this.logger.error(
        `Error en limpieza automática de archivos: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Limpia registros antiguos de eliminaciones completadas
   */
  private async cleanupOldDeletionRecords(): Promise<void> {
    try {
      const oneDayAgo = new Date();
      oneDayAgo.setHours(oneDayAgo.getHours() - 24);
      const cutoffTime = admin.firestore.Timestamp.fromDate(oneDayAgo);

      const oldRecordsSnapshot = await this.firestore
        .collection('scheduledFileDeletions')
        .where('status', 'in', ['completed', 'error'])
        .where('deletedAt', '<=', cutoffTime)
        .limit(50)
        .get();

      if (!oldRecordsSnapshot.empty) {
        const batch = this.firestore.batch();
        oldRecordsSnapshot.docs.forEach((doc) => {
          batch.delete(doc.ref);
        });
        await batch.commit();

        this.logger.log(
          `Limpiados ${oldRecordsSnapshot.size} registros antiguos de eliminación`,
        );
      }
    } catch (error) {
      this.logger.error(`Error limpiando registros antiguos: ${error.message}`);
    }
  }

  // --- Funciones auxiliares ---

  private async showCondominiumOptions(
    context: ConversationContext,
    condominiums: Array<{
      clientId: string;
      condominiumId: string;
      condominiumName?: string;
      tower?: string;
      userId?: string;
    }>,
  ) {
    const { phoneNumber, departmentNumber } = context;

    // Detectamos si hay múltiples opciones dentro del mismo condominio: en ese
    // caso el nombre del condominio no alcanza como discriminador y debemos
    // agregar torre / número de depto / fragmento de userId.
    const condoCountById = new Map<string, number>();
    for (const c of condominiums) {
      const key = `${c.clientId}/${c.condominiumId}`;
      condoCountById.set(key, (condoCountById.get(key) ?? 0) + 1);
    }
    const hasIntraCondoDuplicates = Array.from(condoCountById.values()).some(
      (n) => n > 1,
    );

    const header = hasIntraCondoDuplicates
      ? '🔎 Encontré varias unidades con esos datos. Selecciona la tuya:\n\n'
      : '🔎 Tienes registro en múltiples condominios. Selecciona el correcto:\n\n';

    let msg = header;
    condominiums.forEach((condo, index) => {
      const name = condo.condominiumName
        ? `"${condo.condominiumName}"`
        : `(ID: ${condo.condominiumId})`;

      // Construimos un sufijo con torre + número cuando ayude a distinguir
      const parts: string[] = [];
      if (condo.tower) parts.push(`Torre ${condo.tower}`);
      if (departmentNumber) parts.push(`#${departmentNumber}`);
      // Como último recurso, mostramos los últimos 6 caracteres del userId
      // para que dos opciones idénticas sigan siendo distinguibles.
      if (hasIntraCondoDuplicates && condo.userId && parts.length === 0) {
        parts.push(`ID ${condo.userId.slice(-6)}`);
      }
      const suffix = parts.length > 0 ? ` — ${parts.join(' · ')}` : '';

      msg += `${index + 1}. Condominio ${name}${suffix}\n`;
    });
    msg += '\nEscribe el número de la opción deseada. 🙏';

    await this.sendAndLogMessage({ phoneNumber, message: msg }, context);
  }

  // --- Funciones Auxiliares (Firestore, Media, Limpieza) ---

  /**
   * Descarga el archivo desde la API de WhatsApp y lo sube a Firebase Storage.
   */
  private async downloadAndUploadMedia(
    mediaId: string,
    mimeType: string,
    clientId: string,
    condominiumId: string,
  ): Promise<string> {
    this.logger.log(`Iniciando descarga/subida para mediaId: ${mediaId}`);
    try {
      // 1) Obtener la URL de descarga temporal de WhatsApp
      const mediaApiUrl = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${mediaId}`;
      const mediaResponse = await axios.get(mediaApiUrl, {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        },
      });
      const mediaUrl = mediaResponse.data.url;
      if (!mediaUrl) {
        throw new Error('WhatsApp no devolvió una URL de descarga.');
      }
      this.logger.log(
        `URL temporal de descarga obtenida: ${mediaUrl.substring(0, 50)}...`,
      );

      // 2) Descargar el binario del archivo
      const fileResponse = await axios.get(mediaUrl, {
        responseType: 'arraybuffer', // Importante para obtener el buffer
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        },
      });
      this.logger.log(
        `Archivo binario descargado, tamaño: ${fileResponse.data.length} bytes`,
      );

      // 3) Subir a Firebase Storage
      const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
      if (!bucketName) {
        this.logger.error(
          'FIREBASE_STORAGE_BUCKET no está definido en las variables de entorno.',
        );
        throw new Error('Configuración de almacenamiento incompleta.');
      }
      const bucket = admin.storage().bucket(bucketName);

      const fileExtension = this.getExtensionFromMime(mimeType);
      // Nombre de archivo más descriptivo y único
      const fileName = `voucher_${clientId}_${condominiumId}_${Date.now()}.${fileExtension}`;
      const filePath = `clients/${clientId}/condominiums/${condominiumId}/paymentsVouchers/${fileName}`;

      const file = bucket.file(filePath);

      // Subir el buffer a Storage
      await file.save(fileResponse.data, {
        metadata: { contentType: mimeType },
      });
      this.logger.log(`Archivo subido a Firebase Storage en: ${filePath}`);

      // Hacer el archivo público
      await file.makePublic();
      const publicUrl = `https://storage.googleapis.com/${bucketName}/${filePath}`;

      this.logger.log(`Archivo subido y hecho público: ${publicUrl}`);
      return publicUrl;
    } catch (err) {
      this.logger.error(
        `Error en downloadAndUploadMedia para ${mediaId}: ${err.message}`,
        err.stack,
      );
      if (axios.isAxiosError(err) && err.response) {
        this.logger.error('Axios error details:', err.response.data);
      }
      throw new Error(`Fallo al procesar archivo de WhatsApp: ${err.message}`);
    }
  }

  /**
   * Retorna la extensión de archivo basada en el mimeType.
   */
  private getExtensionFromMime(mimeType: string): string {
    const type = mimeType.toLowerCase();
    if (type.includes('pdf')) return 'pdf';
    if (type.includes('png')) return 'png';
    if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
    if (type.includes('gif')) return 'gif';
    if (type.includes('webp')) return 'webp';
    this.logger.warn(`MimeType no reconocido: ${mimeType}, usando 'bin'`);
    return 'bin';
  }

  /**
   * Encuentra condominios asociados al usuario en Firestore.
   * Busca en la colección 'users' dentro de cada condominio.
   * Devuelve clientId, condominiumId, userId y opcionalmente condominiumName.
   */
  // ============================================================
  // Helpers para el manejo de torres (flujo opcional)
  // ============================================================

  /**
   * Detecta si las coincidencias encontradas pertenecen a torres distintas.
   * Retorna el listado único de torres cuando hay ambigüedad (>=2 torres
   * diferentes). Si hay una sola coincidencia, o todas las coincidencias
   * están en la misma torre, o ninguna tiene torre (condominio sin torres),
   * retorna arreglo vacío.
   */
  private detectTowerAmbiguity(
    matches: Array<{ tower?: string }>,
  ): string[] {
    if (!matches || matches.length <= 1) return [];
    const towers = Array.from(
      new Set(
        matches
          .map((m) => (m.tower ? String(m.tower).trim() : ''))
          .filter(Boolean),
      ),
    );
    return towers.length > 1 ? towers : [];
  }

  /**
   * Resuelve la torre a partir del texto del usuario.
   * Acepta:
   *  - Nombre exacto de la torre ("A", "B1", "Torre 2", "1", "2"...)
   *  - Variantes tipo "torre A" cuando la torre se llama "A"
   *  - Índice numérico ("1", "2"...) según el orden mostrado, SOLO si no hay
   *    match por nombre (para condominios con torres numéricas, ej. "1" y "2",
   *    siempre gana el match literal).
   * La comparación es case-insensitive y normaliza espacios/acentos via cleanInput.
   */
  private resolveTowerFromInput(
    text: string,
    possibleTowers: string[],
  ): string | null {
    if (!possibleTowers || possibleTowers.length === 0) return null;
    const cleaned = this.cleanInput(text);
    if (!cleaned) return null;

    // 1) Match por nombre (prioritario). Incluye variante "torre X".
    const withoutPrefix = cleaned.replace(/^torre/, '').trim();
    for (const t of possibleTowers) {
      const normalized = this.cleanInput(String(t));
      if (normalized === cleaned) return t;
      if (withoutPrefix && normalized === withoutPrefix) return t;
    }

    // 2) Fallback por índice (1..n). Solo se usa cuando ninguna torre coincide
    //    literalmente con el texto — así evitamos que en condominios con torres
    //    "1" y "2" un input "2" devuelva la 2ª torre por posición cuando
    //    realmente el usuario se refería a la torre llamada "2".
    const asIndex = parseInt(cleaned, 10);
    if (
      !isNaN(asIndex) &&
      String(asIndex) === cleaned &&
      asIndex >= 1 &&
      asIndex <= possibleTowers.length
    ) {
      return possibleTowers[asIndex - 1];
    }

    return null;
  }

  /**
   * Intenta desambiguar por teléfono cuando hay varios matches.
   * Regla:
   *  - Si al menos un match tiene `phoneMatches === true`, devolvemos solo los
   *    que coinciden (y suele quedar exactamente uno, caso sano).
   *  - Si ninguno coincide pero todos tienen phone poblado y distinto, devolvemos
   *    [] para que el caller rechace (posible suplantación).
   *  - Si ninguno tiene phone poblado, devolvemos la lista original (no podemos
   *    usar phone para filtrar → caemos al flujo de torre).
   */
  private autoDisambiguateByPhone<
    T extends { phoneMatches?: boolean; phoneInDB?: boolean },
  >(matches: T[]): T[] {
    if (!matches || matches.length === 0) return matches;

    const anyMatch = matches.some((m) => m.phoneMatches === true);
    if (anyMatch) {
      return matches.filter((m) => m.phoneMatches === true);
    }

    const allHavePhone = matches.every((m) => m.phoneInDB === true);
    if (allHavePhone) {
      // Todos tienen phone poblado pero ninguno coincide → no es este usuario
      return [];
    }

    // Al menos uno sin phone poblado → no podemos decidir por phone, seguimos
    return matches;
  }

  private formatTowerOptionsMessage(towers: string[]): string {
    const list = towers.map((t, i) => `${i + 1}. ${t}`).join('\n');
    return `🏢 Encontré varias unidades con ese número en distintas torres.\n\n¿En qué *torre* vives?\n\n${list}\n\nResponde con el *número* de la opción o el *nombre de la torre*.`;
  }

  private async findUserCondominiums(
    originalPhoneWithPrefix: string, // Ej: 52155...
    email?: string,
    departmentNumber?: string,
    tower?: string,
  ): Promise<Array<{
    clientId: string;
    condominiumId: string;
    userId: string;
    condominiumName?: string;
    tower?: string;
    // Si el teléfono en BD del residente coincide con el del chat. Se usa
    // para auto-desambiguar y para validación estricta al elegir torre.
    phoneMatches?: boolean;
    // Indica si el residente tiene algún teléfono registrado. Cuando es false,
    // no podemos validar pertenencia vía phone (admins que no poblaron phone).
    phoneInDB?: boolean;
  }> | null> {
    if (!email || !departmentNumber) return null;

    const phoneForDB = this.toTenDigits(originalPhoneWithPrefix);
    const cleanedEmail = this.cleanInputKeepArroba(email);
    const cleanedDept = this.cleanInput(departmentNumber);
    const deptAsNumber = Number(cleanedDept); // Por si el campo está guardado como número en Firestore
    const deptIsNumeric = !isNaN(deptAsNumber);
    const cleanedTower = tower ? this.cleanInput(tower) : '';

    this.logger.log('Buscando condominios para usuario con datos:', {
      phoneOriginal: originalPhoneWithPrefix,
      phoneForDB,
      email: cleanedEmail,
      departmentNumber: cleanedDept,
      departmentAsNumber: deptIsNumeric ? deptAsNumber : 'no numérico',
    });

    try {
      // --- Estrategia 1: email + número de casa (string) ---
      this.logger.log('🔍 [findUser] Intento 1: email + número (string)');
      let snapshot: FirebaseFirestore.QuerySnapshot | null = null;

      try {
        snapshot = await this.firestore
          .collectionGroup('users')
          .where('email', '==', cleanedEmail)
          .where('number', '==', cleanedDept)
          .get();
        this.logger.log(`✅ [findUser] Intento 1 OK - encontrados: ${snapshot.size}`);
      } catch (e1) {
        this.logger.error(`❌ [findUser] Intento 1 falló: ${e1.message}`);
        if (e1.message?.includes('index')) {
          this.logger.error(`📌 [findUser] Crea el índice en Firestore: ${e1.message}`);
        }
        snapshot = null;
      }

      // --- Estrategia 2: email + número de casa (número/int) ---
      if ((!snapshot || snapshot.empty) && deptIsNumeric) {
        this.logger.log('🔍 [findUser] Intento 2: email + número (int)');
        try {
          snapshot = await this.firestore
            .collectionGroup('users')
            .where('email', '==', cleanedEmail)
            .where('number', '==', deptAsNumber)
            .get();
          this.logger.log(`✅ [findUser] Intento 2 OK - encontrados: ${snapshot.size}`);
        } catch (e2) {
          this.logger.error(`❌ [findUser] Intento 2 falló: ${e2.message}`);
          snapshot = null;
        }
      }

      // --- Estrategia 3: solo por email (diagnóstico) ---
      if (!snapshot || snapshot.empty) {
        this.logger.log('🔍 [findUser] Intento 3: solo por email (diagnóstico)');
        try {
          const emailOnlySnapshot = await this.firestore
            .collectionGroup('users')
            .where('email', '==', cleanedEmail)
            .get();

          this.logger.log(
            `✅ [findUser] Intento 3 OK - usuarios con ese email: ${emailOnlySnapshot.size}`,
          );

          if (!emailOnlySnapshot.empty) {
            emailOnlySnapshot.docs.slice(0, 3).forEach((doc) => {
              const data = doc.data();
              this.logger.warn(
                `👤 [findUser] Usuario en DB - path: ${doc.ref.path} | number: "${data.number}" (${typeof data.number}) | phone: "${data.phone}" (${typeof data.phone}) | email: "${data.email}"`,
              );
            });
          } else {
            this.logger.warn(
              `⚠️ [findUser] No existe ningún usuario con email: "${cleanedEmail}" en toda la DB`,
            );
          }
        } catch (e3) {
          this.logger.error(`❌ [findUser] Intento 3 falló: ${e3.message}`);
        }

        return [];
      }

      // Procesar resultados encontrados
      const results: Array<{
        clientId: string;
        condominiumId: string;
        userId: string;
        condominiumName?: string;
        tower?: string;
        phoneMatches?: boolean;
        phoneInDB?: boolean;
      }> = [];
      const uniquePaths = new Set<string>();

      for (const doc of snapshot.docs) {
        if (uniquePaths.has(doc.ref.path)) continue;
        uniquePaths.add(doc.ref.path);

        const pathSegments = doc.ref.path.split('/');
        if (
          pathSegments.length >= 6 &&
          pathSegments[0] === 'clients' &&
          pathSegments[2] === 'condominiums' &&
          pathSegments[4] === 'users'
        ) {
          const clientId = pathSegments[1];
          const condominiumId = pathSegments[3];
          const userId = doc.id;

          // Verificación de teléfono: se registra si coincide o no con el chat.
          // NO se bloquea aquí (hay residentes sin phone poblado). Los callers
          // deciden: auto-desambiguar cuando hay varios matches, o rechazar
          // después de que el usuario elige torre si el phone no coincide.
          const userData = doc.data();
          const phoneInDBRaw = userData.phone ? String(userData.phone) : '';
          // Normalizamos a 10 dígitos para comparar (tolerante a lada/prefijos)
          const phoneInDBNormalized = phoneInDBRaw
            ? this.toTenDigits(phoneInDBRaw)
            : '';
          const phoneMatches =
            !!phoneInDBNormalized && phoneInDBNormalized === phoneForDB;
          if (phoneInDBRaw && !phoneMatches) {
            this.logger.warn(
              `Teléfono en DB "${phoneInDBRaw}" (normalizado: "${phoneInDBNormalized}") ≠ chat "${phoneForDB}" para usuario ${userId}.`,
            );
          }

          // Torre del usuario (puede estar ausente o vacía; se preserva como
          // viene para mostrarla al usuario, la comparación se hace con
          // cleanInput para ser tolerante a mayúsculas/espacios).
          const userTowerRaw =
            userData.tower !== undefined && userData.tower !== null
              ? String(userData.tower).trim()
              : '';

          // Si se pasó `tower` como filtro, descartar usuarios cuya torre
          // no coincida. Si el usuario en BD no tiene torre, no lo descartamos
          // porque puede ser un condominio sin torres que por casualidad
          // comparte número — pero en ese caso el caller solo debería pasar
          // `tower` cuando ya detectó ambigüedad.
          if (cleanedTower) {
            const userTowerClean = this.cleanInput(userTowerRaw);
            if (!userTowerClean || userTowerClean !== cleanedTower) {
              continue;
            }
          }

          let condominiumName: string | undefined = undefined;
          try {
            const condoDocRef = this.firestore.doc(
              `clients/${clientId}/condominiums/${condominiumId}`,
            );
            const condoSnap = await condoDocRef.get();
            condominiumName = condoSnap.exists
              ? condoSnap.data()?.name
              : undefined;
            this.logger.log(
              `Nombre del condominio ${condominiumId}: ${condominiumName}`,
            );
          } catch (nameError) {
            this.logger.warn(
              `No se pudo obtener el nombre para el condominio ${condominiumId}`,
            );
          }

          results.push({
            clientId,
            condominiumId,
            userId,
            condominiumName,
            tower: userTowerRaw || undefined,
            phoneMatches,
            phoneInDB: !!phoneInDBRaw,
          });
        } else {
          this.logger.warn(
            `Ruta de usuario encontrada no coincide con el patrón esperado: ${doc.ref.path}`,
          );
        }
      }

      this.logger.log(`Condominios válidos encontrados: ${results.length}`);
      return results;
    } catch (error) {
      this.logger.error(
        `Error en Firestore al buscar usuarios: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Muestra los cargos pendientes del usuario en el condominio seleccionado.
   */
  private async showPendingCharges(
    context: ConversationContext,
  ): Promise<void> {
    const { phoneNumber, selectedCondominium, userId } = context;

    if (!selectedCondominium || !userId) {
      this.logger.error(
        `Faltan datos (condominio o userId) para buscar cargos de ${phoneNumber}`,
      );
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '🤔 Ups, parece que falta información para buscar tus cargos. Escribe "Hola" para reiniciar, por favor.',
        },
        context,
      );
      context.state = ConversationState.ERROR;
      return;
    }

    const { clientId, condominiumId } = selectedCondominium;
    const chargesPath = `clients/${clientId}/condominiums/${condominiumId}/users/${userId}/charges`;
    this.logger.log(`Consultando cargos pendientes en: ${chargesPath}`);

    try {
      const chargesRef = this.firestore.collection(chargesPath);
      const chargesSnap = await chargesRef.where('paid', '==', false).get();

      this.logger.log(
        `Consulta de cargos para ${userId} resultó en ${chargesSnap.size} documentos.`,
      );

      if (chargesSnap.empty) {
        context.pendingCharges = [];
        context.state = ConversationState.PAYMENT_AWAITING_FILE;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '✅ ¡Buenas noticias! No encontré cargos pendientes registrados a tu nombre en este momento. Si deseas subir un comprobante para un pago diferente o anticipado, puedes adjuntarlo ahora (imagen o PDF).',
          },
          context,
        );
        return;
      }

      const charges: Array<{
        index: number;
        id: string;
        concept: string;
        amount: number;
      }> = [];
      let idx = 1;
      chargesSnap.forEach((doc) => {
        const data = doc.data();
        if (data.concept && typeof data.amount === 'number') {
          charges.push({
            index: idx,
            id: doc.id,
            concept: data.concept,
            amount: data.amount,
          });
          idx++;
        } else {
          this.logger.warn(
            `Cargo ${doc.id} en ${chargesPath} omitido por datos incompletos.`,
          );
        }
      });

      if (charges.length === 0) {
        context.pendingCharges = [];
        context.state = ConversationState.PAYMENT_AWAITING_FILE;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '✅ No encontré cargos pendientes con detalles completos. Si necesitas subir un comprobante, puedes adjuntarlo ahora.',
          },
          context,
        );
        return;
      }

      context.pendingCharges = charges;

      let replyText =
        'Aquí tienes los cargos pendientes que encontré asociados a tu cuenta 🧾:\n\n';
      charges.forEach((c) => {
        const pesos = (c.amount / 100).toLocaleString('es-MX', {
          style: 'currency',
          currency: 'MXN',
        });
        replyText += `${c.index}. ${c.concept} - ${pesos}\n`;
      });
      replyText +=
        '\nPor favor, respóndeme con el número (o números separados por coma) del cargo(s) que corresponden a tu pago. Ejemplo: "1" o si son varios "1, 2".';

      await this.sendAndLogMessage(
        { phoneNumber, message: replyText },
        context,
      );
    } catch (error) {
      this.logger.error(
        `Error al buscar cargos en ${chargesPath}: ${error.message}`,
        error.stack,
      );
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '😥 Tuve problemas para consultar tus cargos pendientes. Por favor, intenta de nuevo más tarde escribiendo "Hola".',
        },
        context,
      );
    }
  }

  /**
   * Registra el comprobante de pago en Firestore bajo la colección paymentsVouchers del condominio.
   * Retorna { success: true/false } para que el caller pueda decidir qué mensaje enviar.
   */
  private async registerPayment(
    context: ConversationContext,
    fileUrl: string,
  ): Promise<{ success: boolean }> {
    const {
      phoneNumber,
      email,
      departmentNumber,
      selectedCondominium,
      selectedChargeIds,
      userId,
    } = context;

    // Log del estado del contexto para diagnóstico
    this.logger.log(`[registerPayment] Contexto recibido:`, {
      hasSelectedCondominium: !!selectedCondominium,
      hasSelectedChargeIds: !!selectedChargeIds,
      selectedChargeIds: selectedChargeIds ?? 'undefined',
      hasUserId: !!userId,
      userId: userId ?? 'undefined',
      hasEmail: !!email,
      hasDepartmentNumber: !!departmentNumber,
    });

    // selectedCondominium, userId, email y departmentNumber son obligatorios
    // selectedChargeIds es OPCIONAL (puede ser vacío si el usuario no tenía cargos pendientes)
    if (!selectedCondominium || !userId || !email || !departmentNumber) {
      this.logger.error(
        `[registerPayment] ❌ Faltan datos obligatorios en el contexto para ${phoneNumber}. selectedCondominium=${!!selectedCondominium}, userId=${!!userId}, email=${!!email}, dept=${!!departmentNumber}`,
      );
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '❗ Hubo un problema interno, parece que falta información para registrar tu pago. Por favor, inicia de nuevo con "Hola".',
        },
        context,
      );
      context.state = ConversationState.ERROR;
      return { success: false };
    }

    const { clientId, condominiumId } = selectedCondominium;
    const phoneForDB = this.toTenDigits(phoneNumber);
    // Si no hay cargos seleccionados (flujo sin cargos pendientes), se guarda array vacío
    const chargeIds = selectedChargeIds ?? [];

    const voucherData = {
      phoneNumber: phoneForDB,
      originalPhoneNumber: phoneNumber,
      email: this.cleanInputKeepArroba(email),
      departmentNumber: this.cleanInput(departmentNumber),
      userId,
      paymentProofUrl: fileUrl,
      selectedChargeIds: chargeIds,
      status: 'pending_review',
      uploadedBy: 'whatsapp-bot',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      condominiumName: selectedCondominium.condominiumName || null,
    };

    this.logger.log('[registerPayment] Guardando comprobante:', {
      clientId,
      condominiumId,
      userId,
      chargeIds: chargeIds.length > 0 ? chargeIds.join(', ') : '(ninguno)',
    });

    try {
      const voucherRef = await this.firestore
        .collection(
          `clients/${clientId}/condominiums/${condominiumId}/paymentsVouchers`,
        )
        .add(voucherData);
      this.logger.log(
        `[registerPayment] ✅ Comprobante registrado con ID: ${voucherRef.id} para usuario ${userId}`,
      );
      return { success: true };
    } catch (error) {
      this.logger.error(
        `[registerPayment] ❌ Error al guardar en Firestore para ${userId}: ${error.message}`,
        error.stack,
      );
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '❌ Ocurrió un error guardando tu comprobante en nuestra base de datos. Por favor, intenta adjuntar el archivo de nuevo. Si persiste, contacta a soporte.',
        },
        context,
      );
      context.state = ConversationState.ERROR;
      return { success: false };
    }
  }

  // --- Endpoint Opcional (Confirmación Externa) ---

  /**
   * Confirma el pago (posiblemente llamado desde otro sistema/endpoint).
   * Usa la información proporcionada para encontrar al usuario y registrar el comprobante.
   */
  async confirmPayment(
    paymentDto: PaymentConfirmationDto,
  ): Promise<{ success: boolean; message: string; data?: any }> {
    this.logger.log(
      `Iniciando confirmación de pago externa para ${paymentDto.phoneNumber}`,
    );
    try {
      const {
        email,
        departmentNumber,
        phoneNumber,
        paymentProofUrl,
        selectedChargeIds,
      } = paymentDto;

      if (
        !email ||
        !departmentNumber ||
        !phoneNumber ||
        !selectedChargeIds ||
        selectedChargeIds.length === 0
      ) {
        throw new Error(
          'Datos incompletos para confirmar el pago (email, depto, phone, chargeIds son requeridos).',
        );
      }

      const userCondos = await this.findUserCondominiums(
        phoneNumber,
        email,
        departmentNumber,
      );

      if (!userCondos || userCondos.length === 0) {
        throw new Error(
          'Usuario no encontrado con la combinación phone/email/department proporcionada.',
        );
      }

      const userMatch = userCondos[0];
      const { clientId, condominiumId, userId } = userMatch;

      this.logger.log('Usuario encontrado para confirmación externa:', {
        clientId,
        condominiumId,
        userId,
      });

      const phoneForDB = this.toTenDigits(phoneNumber);

      const voucherData: any = {
        phoneNumber: phoneForDB,
        originalPhoneNumber: phoneNumber,
        email: this.cleanInputKeepArroba(email),
        departmentNumber: this.cleanInput(departmentNumber),
        userId: userId,
        paymentProofUrl: paymentProofUrl || null,
        selectedChargeIds: selectedChargeIds,
        status: 'confirmed_external',
        uploadedBy: 'external_api',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        condominiumName: userMatch.condominiumName || null,
      };

      const paymentsVouchersRef = this.firestore.collection(
        `clients/${clientId}/condominiums/${condominiumId}/paymentsVouchers`,
      );
      const voucherDocRef = await paymentsVouchersRef.add(voucherData);
      this.logger.log(
        `Comprobante (externo) almacenado con ID: ${voucherDocRef.id}`,
      );

      return {
        success: true,
        message:
          'Comprobante de pago confirmado y almacenado correctamente vía externa.',
        data: { voucherId: voucherDocRef.id },
      };
    } catch (error) {
      this.logger.error(
        `Error en confirmPayment externo: ${error.message}`,
        error.stack,
      );
      return {
        success: false,
        message: `Error al confirmar pago externo: ${error.message}`,
      };
    }
  }

  // --- Helpers de formato y validación ---

  /**
   * Convierte un número de teléfono mexicano (ej. '52155...' o '5255...') a 10 dígitos (ej. '55...').
   */
  private toTenDigits(num: string): string {
    let digits = num.replace(/\D/g, '');
    if (digits.startsWith('521') && digits.length === 12) {
      digits = '52' + digits.substring(3);
    }
    if (digits.startsWith('52') && digits.length === 12) {
      return digits.substring(2);
    } else if (digits.length === 10) {
      return digits;
    } else if (digits.length > 10) {
      return digits.slice(-10);
    } else {
      this.logger.warn(
        `Número ${num} resultó en ${digits}, que tiene menos de 10 dígitos.`,
      );
      return digits;
    }
  }

  /**
   * Limpia la entrada: minúsculas, sin tildes, sin espacios extra al inicio/fin.
   */
  private cleanInput(input: string): string {
    if (!input) return '';
    let text = input.toLowerCase();
    text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    text = text.trim();
    return text;
  }

  /**
   * Limpia la entrada pero conserva la arroba '@' y puntos '.' (para emails).
   */
  private cleanInputKeepArroba(input: string): string {
    if (!input) return '';
    let text = input.toLowerCase().trim();
    text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return text;
  }

  /**
   * Validación básica de formato de correo electrónico.
   */
  private isValidEmail(email: string): boolean {
    if (!email) return false;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Verifica si el texto es un saludo o palabra clave para iniciar/reiniciar.
   */
  private isGreeting(text: string): boolean {
    const greetings = [
      'hola',
      'ola',
      'alo',
      'iniciar',
      'inicio',
      'empezar',
      'comenzar',
      'buenos dias',
      'buen dia',
      'buenas tardes',
      'buena tarde',
      'buenas noches',
      'buena noche',
      'hey',
      'buenas',
      'k onda',
      'ayuda',
      'soporte',
      'info',
      'pago',
      'pagar',
      'comprobante',
      'recibo',
    ];
    return greetings.some((g) => text.includes(g));
  }

  /**
   * Envía un documento directamente a través de WhatsApp API
   */
  private async sendDocumentMessage(
    phoneNumber: string,
    document: PublicDocument,
    context?: ConversationContext,
  ): Promise<{ success: boolean; message: string }> {
    try {
      this.logger.log(`Enviando documento "${document.name}" a ${phoneNumber}`);

      const apiUrl = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${process.env.PHONE_NUMBER_ID}/messages`;
      const recipientPhoneNumber = normalizeMexNumber(phoneNumber);

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientPhoneNumber,
        type: 'document',
        document: {
          link: document.fileUrl,
          caption: `📄 *${document.name}*\n\n${document.description}\n\n✅ ¡Aquí tienes el documento solicitado!`,
          filename: `${document.name}.pdf`, // Usar el name como filename
        },
      };

      // CRÍTICO: Enviar el documento a través de WhatsApp API
      await axios.post(apiUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        },
      });

      // Registrar en auditoría
      await this.logToAudit(
        context || null,
        'out',
        {
          type: 'document',
          documentName: document.name,
          documentId: document.id,
        },
        { phoneNumber },
      );

      this.logger.log(`Documento enviado exitosamente a ${phoneNumber}`);
      return {
        success: true,
        message: 'Documento enviado correctamente.',
      };
    } catch (error) {
      this.logger.error(
        `Error enviando documento a ${phoneNumber}: ${error.message}`,
        error.stack,
      );

      if (error.response) {
        this.logger.error('WhatsApp API error data:', error.response.data);
      }

      // Si falla el envío directo, intentar con URL acortada
      return await this.sendDocumentWithShortenedUrl(
        phoneNumber,
        document,
        context,
      );
    }
  }

  /**
   * Fallback: Envía documento usando URL acortada
   */
  private async sendDocumentWithShortenedUrl(
    phoneNumber: string,
    document: PublicDocument,
    context?: ConversationContext,
  ): Promise<{ success: boolean; message: string }> {
    try {
      this.logger.log(
        `Enviando documento con URL acortada para ${phoneNumber}`,
      );

      // Acortar la URL
      const shortUrl = await this.publicDocumentsService.shortenUrl(
        document.fileUrl,
      );

      // Formatear mensaje con URL acortada
      const messageText = this.publicDocumentsService
        .formatDocumentMessage(document)
        .replace('{URL_PLACEHOLDER}', shortUrl);

      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: messageText,
        },
        context,
      );

      return {
        success: true,
        message: 'Documento enviado con URL acortada.',
      };
    } catch (error) {
      this.logger.error(
        `Error enviando documento con URL acortada: ${error.message}`,
        error.stack,
      );
      return {
        success: false,
        message: `Error al enviar documento: ${error.message}`,
      };
    }
  }

  // =========================================================================
  // Flujo de visitas programadas (opción 4)
  // =========================================================================

  private async handleVisitEmailInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    if (!this.isValidEmail(text)) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '😅 Parece que hay un problema con el correo. Volvamos al menú.\n\n' +
              this.getMenuMessage(),
          },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `📧 Ese correo no parece válido. Debe tener el formato *nombre@dominio.com*\n\n_(Intento ${context.retryCount} de 3 — escribe *cancelar* para salir)_`,
        },
        context,
      );
      return;
    }
    context.email = this.cleanInputKeepArroba(text);
    context.retryCount = 0;
    context.state = ConversationState.VISIT_AWAITING_DEPARTMENT;
    await this.sendAndLogMessage(
      {
        phoneNumber,
        message:
          '✉️ Perfecto. Ahora dime tu *número de departamento o casa* tal como aparece en la plataforma (ej: 101, A-3, 463).',
      },
      context,
    );
  }

  private async handleVisitDepartmentInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    context.departmentNumber = text;

    try {
      const possibleCondos = await this.findUserCondominiums(
        context.phoneNumber,
        context.email,
        context.departmentNumber,
      );

      if (!possibleCondos || possibleCondos.length === 0) {
        context.retryCount = (context.retryCount ?? 0) + 1;
        if (context.retryCount >= 3) {
          this.resetContext(context);
          context.state = ConversationState.MENU_SELECTION;
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message:
                '😅 No logramos encontrar tu cuenta después de varios intentos. Verifica que el correo y número coincidan exactamente con los registrados.\n\n' +
                this.getMenuMessage(),
            },
            context,
          );
          return;
        }
        context.email = undefined;
        context.departmentNumber = undefined;
        context.state = ConversationState.VISIT_AWAITING_EMAIL;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `🔍 No encontré ninguna cuenta con esos datos. ¿Puedes intentarlo de nuevo? Ingresa tu *correo electrónico* registrado.\n\n_(Intento ${context.retryCount} de 3)_`,
          },
          context,
        );
        return;
      }

      // Auto-desambiguación por teléfono (mismo patrón que pagos/documentos)
      const disambiguated = this.autoDisambiguateByPhone(possibleCondos);
      if (disambiguated.length === 0) {
        context.retryCount = (context.retryCount ?? 0) + 1;
        if (context.retryCount >= 3) {
          this.resetContext(context);
          context.state = ConversationState.MENU_SELECTION;
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message: `🚫 Los datos no coinciden con el teléfono registrado. Si crees que es un error, contacta a tu administrador.\n\n${this.getMenuMessage()}`,
            },
            context,
          );
          return;
        }
        context.email = undefined;
        context.departmentNumber = undefined;
        context.state = ConversationState.VISIT_AWAITING_EMAIL;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `🔒 Por seguridad, los datos deben coincidir con el teléfono registrado. Vuelve a intentarlo con tu *correo electrónico* registrado.\n\n_(Intento ${context.retryCount} de 3)_`,
          },
          context,
        );
        return;
      }
      const matches = disambiguated;

      const ambiguousTowers = this.detectTowerAmbiguity(matches);
      if (ambiguousTowers.length > 0) {
        context.possibleCondominiums = matches;
        context.possibleTowers = ambiguousTowers;
        context.retryCount = 0;
        context.state = ConversationState.VISIT_AWAITING_TOWER;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: this.formatTowerOptionsMessage(ambiguousTowers),
          },
          context,
        );
        return;
      }

      if (matches.length === 1) {
        context.userId = matches[0].userId;
        context.selectedCondominium = matches[0];
        context.retryCount = 0;
        context.state = ConversationState.VISIT_AWAITING_TYPE;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `✅ ¡Te encontré! Estás en *${matches[0].condominiumName || matches[0].condominiumId}*.\n\n${this.getVisitTypePrompt()}`,
          },
          context,
        );
      } else {
        context.userId = undefined;
        context.possibleCondominiums = matches;
        context.state =
          ConversationState.VISIT_AWAITING_CONDOMINIUM_SELECTION;
        await this.showCondominiumOptions(context, matches);
      }
    } catch (error) {
      this.logger.error(
        `❌ [handleVisitDept] Error buscando condominios para visitas en ${phoneNumber}: ${error.message}`,
        error.stack,
      );
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '😥 Hubo un problema buscando tu información. Por favor, intenta de nuevo más tarde escribiendo "Hola".',
        },
        context,
      );
    }
  }

  private async handleVisitTowerInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    if (
      !context.possibleTowers ||
      context.possibleTowers.length === 0 ||
      !context.possibleCondominiums
    ) {
      this.resetContext(context);
      context.state = ConversationState.MENU_SELECTION;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `😅 Se perdió el contexto. Empecemos de nuevo.\n\n${this.getMenuMessage()}`,
        },
        context,
      );
      return;
    }

    const resolved = this.resolveTowerFromInput(text, context.possibleTowers);
    if (!resolved) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `😅 No logré identificar la torre. Volvamos al menú.\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `🤔 No reconocí esa torre. Responde con el *número* o el *nombre exacto*:\n\n${context.possibleTowers
            .map((t, i) => `${i + 1}. ${t}`)
            .join('\n')}\n\n_(Intento ${context.retryCount} de 3)_`,
        },
        context,
      );
      return;
    }

    context.tower = resolved;
    const filtered = context.possibleCondominiums.filter(
      (m) =>
        m.tower &&
        this.cleanInput(String(m.tower)) === this.cleanInput(resolved),
    );

    if (filtered.length === 0) {
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '😥 Hubo un problema filtrando por torre. Escribe "Hola" para reiniciar.',
        },
        context,
      );
      return;
    }

    const phoneConflict = filtered.every(
      (m) => m.phoneInDB === true && m.phoneMatches !== true,
    );
    if (phoneConflict) {
      this.resetContext(context);
      context.state = ConversationState.MENU_SELECTION;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `🚫 Esa torre no está asociada a tu teléfono. Por seguridad no puedo continuar.\n\n${this.getMenuMessage()}`,
        },
        context,
      );
      return;
    }

    context.retryCount = 0;
    context.possibleTowers = undefined;
    if (filtered.length === 1) {
      context.userId = filtered[0].userId;
      context.selectedCondominium = filtered[0];
      context.possibleCondominiums = undefined;
      context.state = ConversationState.VISIT_AWAITING_TYPE;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `✅ ¡Te encontré! Estás en *${filtered[0].condominiumName || filtered[0].condominiumId}*, torre *${resolved}*.\n\n${this.getVisitTypePrompt()}`,
        },
        context,
      );
    } else {
      context.userId = undefined;
      context.possibleCondominiums = filtered;
      context.state =
        ConversationState.VISIT_AWAITING_CONDOMINIUM_SELECTION;
      await this.showCondominiumOptions(context, filtered);
    }
  }

  private async handleVisitCondominiumSelection(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    const index = parseInt(text, 10);
    if (
      isNaN(index) ||
      !context.possibleCondominiums ||
      index < 1 ||
      index > context.possibleCondominiums.length
    ) {
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '🚫 Opción no válida. Escribe el número correspondiente al condominio de la lista.',
        },
        context,
      );
      return;
    }
    const selected = context.possibleCondominiums[index - 1];
    context.selectedCondominium = selected;
    if (selected.userId) context.userId = selected.userId;
    if (selected.tower) context.tower = selected.tower;
    context.state = ConversationState.VISIT_AWAITING_TYPE;
    await this.sendAndLogMessage(
      {
        phoneNumber,
        message: `✔️ Seleccionado: ${selected.condominiumName || selected.condominiumId}.\n\n${this.getVisitTypePrompt()}`,
      },
      context,
    );
  }

  /**
   * Mensaje que pregunta si la visita es única o recurrente.
   */
  private getVisitTypePrompt(): string {
    return `🔁 ¿Esta visita es *única* o *recurrente*?\n\n1️⃣ Única (una sola vez)\n2️⃣ Recurrente (limpieza, maestros, mantenimiento, etc.)\n\nResponde *1* o *2*.`;
  }

  private async handleVisitTypeInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    const t = text.trim().toLowerCase();
    let chosen: 'single' | 'recurring' | null = null;

    if (t === '1' || t === 'unica' || t === 'única' || t === 'una vez' || t === 'una') {
      chosen = 'single';
    } else if (
      t === '2' ||
      t === 'recurrente' ||
      t === 'recurrentes' ||
      t === 'multiple' ||
      t === 'varias' ||
      t === 'repetida'
    ) {
      chosen = 'recurring';
    }

    if (!chosen) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `😅 No te entendí. Volvamos al menú.\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `🤔 Responde *1* (única) o *2* (recurrente).`,
        },
        context,
      );
      return;
    }

    context.visitDraft = context.visitDraft || {};
    context.visitDraft.visitType = chosen;
    context.retryCount = 0;
    context.state = ConversationState.VISIT_AWAITING_VISITOR_NAME;
    await this.sendAndLogMessage(
      {
        phoneNumber,
        message:
          chosen === 'single'
            ? '👤 ¿Cuál es el *nombre completo de tu visitante*?'
            : '👤 ¿Cuál es el *nombre completo* de la persona o servicio? (ej: *Lupita Hernández* o *Equipo de limpieza Limpio Total*)',
      },
      context,
    );
  }

  private async handleVisitVisitorNameInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    const trimmed = text.trim();
    // Validación: debe ser nombre razonable (entre 3 y 80 chars, al menos 1 espacio o palabra)
    if (trimmed.length < 3 || trimmed.length > 80) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `😅 No logré obtener un nombre válido. Volvamos al menú.\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '🤔 Necesito el *nombre completo* del visitante (entre 3 y 80 caracteres). Por ejemplo: *Juan Pérez*.',
        },
        context,
      );
      return;
    }
    context.visitDraft = context.visitDraft || {};
    // Capitalizar suavemente cada palabra
    context.visitDraft.visitorName = trimmed
      .split(/\s+/)
      .map((w) =>
        w.length > 0 ? w[0].toLocaleUpperCase('es-MX') + w.slice(1) : w,
      )
      .join(' ');
    context.retryCount = 0;

    if (context.visitDraft.visitType === 'recurring') {
      context.state = ConversationState.VISIT_AWAITING_DAYS_OF_WEEK;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `📆 ¿Qué *días de la semana* viene ${context.visitDraft.visitorName}?\n\nEjemplos:\n• *lunes y miércoles*\n• *lunes a viernes*\n• *martes, jueves y sábado*\n• *fines de semana*\n• *todos los días*`,
        },
        context,
      );
    } else {
      context.state = ConversationState.VISIT_AWAITING_ARRIVAL;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `📅 *¿Cuándo llega ${context.visitDraft.visitorName}?*\n\nPuedes escribirlo natural, por ejemplo:\n• *hoy 4pm*\n• *mañana 10am*\n• *sábado 18:00*\n• *27/04 14:30*`,
        },
        context,
      );
    }
  }

  private async handleVisitArrivalInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    const parsed = this.scheduledVisitsService.parseSpanishDateTime(text);
    if (!parsed) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `😅 No logré entender la fecha y hora. Volvamos al menú.\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '🤔 No entendí esa fecha. Intenta con un formato como:\n• *hoy 4pm*\n• *mañana 10am*\n• *sábado 18:00*\n• *27/04 14:30*',
        },
        context,
      );
      return;
    }

    const validation = this.scheduledVisitsService.validateArrival(parsed.date);
    if (!validation.ok) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `😅 No pudimos validar la fecha de llegada. Volvamos al menú.\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        { phoneNumber, message: `⚠️ ${validation.reason}` },
        context,
      );
      return;
    }

    context.visitDraft = context.visitDraft || {};
    context.visitDraft.arrivalAtISO = parsed.date.toISOString();
    context.visitDraft.arrivalLabel = parsed.humanLabel;
    context.retryCount = 0;
    context.state = ConversationState.VISIT_AWAITING_DEPARTURE;
    await this.sendAndLogMessage(
      {
        phoneNumber,
        message: `🕒 Llegada: *${parsed.humanLabel}*\n\n¿*Hasta qué hora* puede estar el visitante? (ej: *6pm*, *18:30*, *mañana 9am*)`,
      },
      context,
    );
  }

  private async handleVisitDepartureInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    const arrivalISO = context.visitDraft?.arrivalAtISO;
    if (!arrivalISO) {
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: '❌ Error interno. Escribe "Hola" para reiniciar.',
        },
        context,
      );
      return;
    }
    const arrival = new Date(arrivalISO);

    const parsed =
      this.scheduledVisitsService.parseDepartureRelativeToArrival(
        text,
        arrival,
      );
    if (!parsed) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `😅 No logré entender la hora de salida. Volvamos al menú.\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '🤔 No entendí esa hora. Intenta con *6pm*, *18:30* o *mañana 9am*.',
        },
        context,
      );
      return;
    }

    const validation = this.scheduledVisitsService.validateDeparture(
      arrival,
      parsed.date,
    );
    if (!validation.ok) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `😅 No pudimos validar la hora de salida. Volvamos al menú.\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        { phoneNumber, message: `⚠️ ${validation.reason}` },
        context,
      );
      return;
    }

    context.visitDraft = context.visitDraft || {};
    context.visitDraft.departureAtISO = parsed.date.toISOString();
    context.visitDraft.departureLabel = parsed.humanLabel;
    context.retryCount = 0;
    context.state = ConversationState.VISIT_AWAITING_VEHICLE;
    await this.sendAndLogMessage(
      {
        phoneNumber,
        message: `🚗 ¿Tu visitante llegará en *vehículo*? Si sí, comparte las *placas* (y si quieres, modelo/color). Ejemplo: *ABC-123 Mazda gris*.\n\nSi no aplica, responde *no*.`,
      },
      context,
    );
  }

  // ─── Flujo recurrente ───

  private async handleVisitDaysOfWeekInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    const days = this.scheduledVisitsService.parseDaysOfWeek(text);
    if (!days || days.length === 0) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `😅 No logré entender los días. Volvamos al menú.\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '🤔 No entendí esos días. Intenta con *lunes y miércoles*, *lunes a viernes*, *fines de semana*, etc.',
        },
        context,
      );
      return;
    }
    context.visitDraft = context.visitDraft || {};
    context.visitDraft.daysOfWeek = days;
    context.retryCount = 0;
    context.state = ConversationState.VISIT_AWAITING_DAILY_ARRIVAL;
    await this.sendAndLogMessage(
      {
        phoneNumber,
        message: `🕗 Días: *${this.scheduledVisitsService.formatDaysOfWeek(days)}*\n\n¿A qué *hora llega* cada día? (ej: *8am*, *07:30*, *14:00*)`,
      },
      context,
    );
  }

  private async handleVisitDailyArrivalInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    const time = this.scheduledVisitsService.parseTimeOfDay(text);
    if (!time) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `😅 No logré entender la hora. Volvamos al menú.\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '🤔 No entendí esa hora. Intenta con *8am*, *07:30* o *14:00*.',
        },
        context,
      );
      return;
    }
    context.visitDraft = context.visitDraft || {};
    context.visitDraft.dailyArrivalTime = time;
    context.retryCount = 0;
    context.state = ConversationState.VISIT_AWAITING_DAILY_DEPARTURE;
    await this.sendAndLogMessage(
      {
        phoneNumber,
        message: `🕓 Llegada diaria: *${time}*\n\n¿A qué *hora se va* cada día?`,
      },
      context,
    );
  }

  private async handleVisitDailyDepartureInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    const time = this.scheduledVisitsService.parseTimeOfDay(text);
    if (!time) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `😅 No logré entender la hora. Volvamos al menú.\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '🤔 No entendí esa hora. Intenta con *6pm*, *18:30* o *14:00*.',
        },
        context,
      );
      return;
    }

    // Validar arrival < departure
    const arr = context.visitDraft?.dailyArrivalTime;
    if (!arr) {
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: '❌ Error interno. Escribe "Hola" para reiniciar.',
        },
        context,
      );
      return;
    }
    const arrMin = +arr.split(':')[0] * 60 + +arr.split(':')[1];
    const depMin = +time.split(':')[0] * 60 + +time.split(':')[1];
    if (depMin - arrMin < 5) {
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '⚠️ La hora de salida debe ser al menos 5 minutos después de la entrada. Intenta otra hora.',
        },
        context,
      );
      return;
    }

    context.visitDraft = context.visitDraft || {};
    context.visitDraft.dailyDepartureTime = time;
    context.retryCount = 0;
    context.state = ConversationState.VISIT_AWAITING_START_DATE;
    await this.sendAndLogMessage(
      {
        phoneNumber,
        message: `🕔 Salida diaria: *${time}*\n\n📅 ¿Desde qué *fecha empieza*? (ej: *hoy*, *mañana*, *5/5/2026*)`,
      },
      context,
    );
  }

  private async handleVisitStartDateInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    const startDate = this.scheduledVisitsService.parseStartDate(text);
    if (!startDate) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `😅 No logré entender la fecha. Volvamos al menú.\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '🤔 No entendí esa fecha. Intenta con *hoy*, *mañana*, *lunes*, *5/5* o *5/5/2026*.',
        },
        context,
      );
      return;
    }

    // Validar que no sea muy en el pasado (tolerancia de 1 día)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (startDate.getTime() < today.getTime()) {
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '⚠️ La fecha de inicio no puede ser anterior a hoy. Intenta otra fecha.',
        },
        context,
      );
      return;
    }

    context.visitDraft = context.visitDraft || {};
    context.visitDraft.startDateISO = startDate.toISOString();
    context.retryCount = 0;
    context.state = ConversationState.VISIT_AWAITING_END_DATE;
    await this.sendAndLogMessage(
      {
        phoneNumber,
        message: `📅 Inicia: *${this.scheduledVisitsService.formatHumanDate(startDate)}*\n\n¿Hasta cuándo? (ej: *1 mes*, *3 meses*, *31/12*, *indefinido*)\n\n_Máx. 6 meses._`,
      },
      context,
    );
  }

  private async handleVisitEndDateInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    const startISO = context.visitDraft?.startDateISO;
    if (!startISO) {
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: '❌ Error interno. Escribe "Hola" para reiniciar.',
        },
        context,
      );
      return;
    }
    const startDate = new Date(startISO);
    const endDate = this.scheduledVisitsService.parseEndDate(text, startDate);
    if (!endDate) {
      context.retryCount = (context.retryCount ?? 0) + 1;
      if (context.retryCount >= 3) {
        this.resetContext(context);
        context.state = ConversationState.MENU_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `😅 No logré entender la fecha final. Volvamos al menú.\n\n${this.getMenuMessage()}`,
          },
          context,
        );
        return;
      }
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '🤔 No entendí. Intenta con *1 mes*, *3 meses*, *31/12* o *indefinido*.',
        },
        context,
      );
      return;
    }

    // Validar la recurrencia completa
    if (
      !context.visitDraft?.daysOfWeek ||
      !context.visitDraft?.dailyArrivalTime ||
      !context.visitDraft?.dailyDepartureTime
    ) {
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: '❌ Error interno. Escribe "Hola" para reiniciar.',
        },
        context,
      );
      return;
    }
    const validation = this.scheduledVisitsService.validateRecurrence({
      daysOfWeek: context.visitDraft.daysOfWeek,
      dailyArrivalTime: context.visitDraft.dailyArrivalTime,
      dailyDepartureTime: context.visitDraft.dailyDepartureTime,
      startDate,
      endDate,
    });
    if (!validation.ok) {
      await this.sendAndLogMessage(
        { phoneNumber, message: `⚠️ ${validation.reason}` },
        context,
      );
      return;
    }

    context.visitDraft.endDateISO = endDate.toISOString();
    context.retryCount = 0;
    context.state = ConversationState.VISIT_AWAITING_VEHICLE;
    await this.sendAndLogMessage(
      {
        phoneNumber,
        message: `📅 Termina: *${this.scheduledVisitsService.formatHumanDate(endDate)}*\n\n🚗 ¿Llega en *vehículo*? Comparte placas (ej: *ABC-123 Mazda gris*) o responde *no*.`,
      },
      context,
    );
  }

  // ─── Vehículo y resumen (compartido) ───

  private async handleVisitVehicleInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    const cleaned = text.trim();
    const skipWords = ['no', 'ninguno', 'no aplica', 'na', 'sin auto', 'sin carro'];
    const isSkip = skipWords.includes(cleaned.toLowerCase());

    context.visitDraft = context.visitDraft || {};
    if (!isSkip && cleaned.length > 0) {
      // Heurística sencilla: lo primero parecido a placas se guarda como plates,
      // el resto como descripción. Si no detectamos placas, todo va a description.
      const platesMatch = cleaned.match(/[A-Z0-9]{3,4}[\s-]?[A-Z0-9]{2,4}/i);
      if (platesMatch) {
        context.visitDraft.vehiclePlates = platesMatch[0]
          .toUpperCase()
          .replace(/\s+/g, '');
        const description = cleaned.replace(platesMatch[0], '').trim();
        if (description) {
          context.visitDraft.vehicleDescription = description;
        }
      } else {
        context.visitDraft.vehicleDescription = cleaned;
      }
    }

    context.state = ConversationState.VISIT_CONFIRMING;
    await this.sendVisitSummary(context);
  }

  private async sendVisitSummary(context: ConversationContext) {
    const { phoneNumber, visitDraft, selectedCondominium, tower } = context;
    if (!visitDraft || !selectedCondominium) {
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: '❌ Error interno. Escribe "Hola" para reiniciar.',
        },
        context,
      );
      return;
    }

    const vehicleLine = visitDraft.vehiclePlates
      ? `🚗 Vehículo: *${visitDraft.vehiclePlates}*${visitDraft.vehicleDescription ? ` (${visitDraft.vehicleDescription})` : ''}`
      : visitDraft.vehicleDescription
        ? `🚗 Vehículo: ${visitDraft.vehicleDescription}`
        : '🚗 Sin vehículo';

    const lines: string[] = [
      '📋 *Confirma los datos de la visita:*',
      '',
      `👤 Visitante: *${visitDraft.visitorName}*`,
      `🏢 Condominio: ${selectedCondominium.condominiumName || selectedCondominium.condominiumId}${tower ? ` · Torre ${tower}` : ''}`,
      `🚪 Departamento: ${context.departmentNumber}`,
    ];

    if (visitDraft.visitType === 'recurring') {
      const daysLabel = this.scheduledVisitsService.formatDaysOfWeek(
        visitDraft.daysOfWeek || [],
      );
      const startD = visitDraft.startDateISO
        ? this.scheduledVisitsService.formatHumanDate(
            new Date(visitDraft.startDateISO),
          )
        : '—';
      const endD = visitDraft.endDateISO
        ? this.scheduledVisitsService.formatHumanDate(
            new Date(visitDraft.endDateISO),
          )
        : '—';
      lines.push(`🔁 Tipo: *Recurrente*`);
      lines.push(`📆 Días: *${daysLabel}*`);
      lines.push(
        `🕓 Horario diario: *${visitDraft.dailyArrivalTime} – ${visitDraft.dailyDepartureTime}*`,
      );
      lines.push(`📅 Vigencia: *${startD}* a *${endD}*`);
    } else {
      lines.push(`🕓 Llegada: *${visitDraft.arrivalLabel}*`);
      lines.push(`🕕 Salida: *${visitDraft.departureLabel}*`);
    }

    lines.push(vehicleLine);
    lines.push('');
    lines.push(
      'Responde *sí* para confirmar y generar el QR, o *no* para cancelar.',
    );

    await this.sendAndLogMessage(
      { phoneNumber, message: lines.join('\n') },
      context,
    );
  }

  private async handleVisitConfirmation(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;
    const t = text.trim().toLowerCase();
    const yes = ['si', 'sí', 'yes', 'confirmar', 'ok', 'dale', 'correcto'];
    const no = ['no', 'cancelar', 'cancel', 'nel', 'incorrecto'];

    if (no.includes(t)) {
      this.resetContext(context);
      context.state = ConversationState.MENU_SELECTION;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: `❎ Visita cancelada. ¿Hay algo más en lo que pueda ayudarte?\n\n${this.getMenuMessage()}`,
        },
        context,
      );
      return;
    }

    if (!yes.includes(t)) {
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '🤔 Responde *sí* para confirmar y generar el QR, o *no* para cancelar.',
        },
        context,
      );
      return;
    }

    // Confirmación: crear visita y enviar QR
    await this.finalizeVisitRegistration(context);
  }

  private async finalizeVisitRegistration(context: ConversationContext) {
    const { phoneNumber, visitDraft, selectedCondominium, userId, email, departmentNumber, tower } =
      context;

    const visitType = visitDraft?.visitType || 'single';

    // Validación común
    const baseMissing =
      !visitDraft ||
      !visitDraft.visitorName ||
      !selectedCondominium ||
      !userId ||
      !email ||
      !departmentNumber;

    // Validación específica por tipo
    const singleMissing =
      visitType === 'single' &&
      (!visitDraft?.arrivalAtISO ||
        !visitDraft?.departureAtISO ||
        !visitDraft?.arrivalLabel ||
        !visitDraft?.departureLabel);

    const recurringMissing =
      visitType === 'recurring' &&
      (!visitDraft?.daysOfWeek ||
        !visitDraft?.dailyArrivalTime ||
        !visitDraft?.dailyDepartureTime ||
        !visitDraft?.startDateISO ||
        !visitDraft?.endDateISO);

    if (baseMissing || singleMissing || recurringMissing) {
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message: '❌ Error interno al guardar la visita. Escribe "Hola" para reiniciar.',
        },
        context,
      );
      return;
    }

    try {
      // Recuperar datos extra del residente para trazabilidad
      let residentName: string | undefined;
      let residentLastName: string | undefined;
      try {
        const userDocRef = this.firestore.doc(
          `clients/${selectedCondominium.clientId}/condominiums/${selectedCondominium.condominiumId}/users/${userId}`,
        );
        const userDoc = await userDocRef.get();
        if (userDoc.exists) {
          const u = userDoc.data();
          residentName = u?.name;
          residentLastName = u?.lastName;
        }
      } catch (e) {
        this.logger.warn(
          `No se pudo leer datos del residente ${userId}: ${e.message}`,
        );
      }

      // Construir labels finales y payload según tipo
      let arrivalLabel: string;
      let departureLabel: string;
      let arrivalAt: Date | undefined;
      let departureAt: Date | undefined;
      let recurrence:
        | {
            daysOfWeek: number[];
            dailyArrivalTime: string;
            dailyDepartureTime: string;
            startDate: Date;
            endDate: Date;
          }
        | undefined;

      if (visitType === 'single') {
        arrivalAt = new Date(visitDraft!.arrivalAtISO!);
        departureAt = new Date(visitDraft!.departureAtISO!);
        arrivalLabel = visitDraft!.arrivalLabel!;
        departureLabel = visitDraft!.departureLabel!;
      } else {
        recurrence = {
          daysOfWeek: visitDraft!.daysOfWeek!,
          dailyArrivalTime: visitDraft!.dailyArrivalTime!,
          dailyDepartureTime: visitDraft!.dailyDepartureTime!,
          startDate: new Date(visitDraft!.startDateISO!),
          endDate: new Date(visitDraft!.endDateISO!),
        };
        const daysLabel = this.scheduledVisitsService.formatDaysOfWeek(
          recurrence.daysOfWeek,
        );
        const startD = this.scheduledVisitsService.formatHumanDate(
          recurrence.startDate,
        );
        const endD = this.scheduledVisitsService.formatHumanDate(
          recurrence.endDate,
        );
        arrivalLabel = `${daysLabel}, ${recurrence.dailyArrivalTime} (desde ${startD})`;
        departureLabel = `${recurrence.dailyDepartureTime} (hasta ${endD})`;
      }

      const result = await this.scheduledVisitsService.createScheduledVisit({
        clientId: selectedCondominium.clientId,
        condominiumId: selectedCondominium.condominiumId,
        condominiumName: selectedCondominium.condominiumName,
        resident: {
          userId,
          email,
          departmentNumber,
          tower: tower || selectedCondominium.tower || null,
          phoneNumber,
          name: residentName,
          lastName: residentLastName,
        },
        visitorName: visitDraft!.visitorName!,
        visitorVehicle:
          visitDraft!.vehiclePlates || visitDraft!.vehicleDescription
            ? {
                plates: visitDraft!.vehiclePlates,
                description: visitDraft!.vehicleDescription,
              }
            : undefined,
        visitType,
        arrivalAt,
        departureAt,
        recurrence,
        arrivalLabel,
        departureLabel,
      });

      const caption =
        visitType === 'recurring'
          ? `✅ *Visita recurrente registrada para ${visitDraft!.visitorName}*\n` +
            `📆 ${this.scheduledVisitsService.formatDaysOfWeek(recurrence!.daysOfWeek)}\n` +
            `🕓 ${recurrence!.dailyArrivalTime} – ${recurrence!.dailyDepartureTime}\n\n` +
            `Este *mismo QR* se podrá usar cada día válido del rango. Compártelo con tu visita.`
          : `✅ *Visita registrada para ${visitDraft!.visitorName}*\n` +
            `🕓 ${arrivalLabel} → ${departureLabel}\n\n` +
            `Comparte este QR con tu visita. La caseta lo escaneará al llegar.`;

      const sent = await this.scheduledVisitsService.sendQrImageMessage(
        phoneNumber,
        result.qrImageUrl,
        caption,
      );

      if (!sent.success) {
        // Fallback: enviar URL si no se pudo mandar la imagen
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              `✅ Visita registrada. Si no te llegó el QR como imagen, ábrelo aquí: ${result.qrImageUrl}`,
          },
          context,
        );
      } else {
        // Auditar el envío del QR
        await this.logToAudit(
          context,
          'out',
          {
            type: 'visit_qr',
            visitId: result.visitId,
            qrId: result.qrId,
          },
          { phoneNumber },
        );
      }

      context.state = ConversationState.COMPLETED;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '🎉 ¡Listo! La visita está programada y la caseta podrá validar el QR cuando llegue. Si necesitas algo más, escribe *Hola*.',
        },
        context,
      );
    } catch (error) {
      this.logger.error(
        `Error al crear visita programada para ${phoneNumber}: ${error.message}`,
        error.stack,
      );
      context.state = ConversationState.ERROR;
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '😥 Hubo un problema generando la visita. Por favor, intenta nuevamente escribiendo "Hola".',
        },
        context,
      );
    }
  }

  /**
   * Cron diario que marca como expiradas las visitas vencidas.
   * Se ejecuta cada 30 minutos para mantener el estado actualizado sin
   * sobrecargar Firestore.
   */
  @Cron('0 */30 * * * *')
  async runScheduledVisitsExpiry(): Promise<void> {
    try {
      const expired = await this.scheduledVisitsService.expireOverdueVisits();
      if (expired > 0) {
        this.logger.log(`runScheduledVisitsExpiry: ${expired} visitas marcadas como expiradas.`);
      }
    } catch (error) {
      this.logger.error(
        `Error al expirar visitas vencidas: ${error.message}`,
        error.stack,
      );
    }
  }
}
