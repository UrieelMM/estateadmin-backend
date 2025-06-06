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
  PAYMENT_MULTIPLE_CONDOMINIUMS = 'PAYMENT_MULTIPLE_CONDOMINIUMS',
  PAYMENT_AWAITING_CONDOMINIUM_SELECTION = 'PAYMENT_AWAITING_CONDOMINIUM_SELECTION',
  PAYMENT_AWAITING_CHARGE_SELECTION = 'PAYMENT_AWAITING_CHARGE_SELECTION',
  PAYMENT_AWAITING_FILE = 'PAYMENT_AWAITING_FILE',

  // Estados para consultar documentos (nuevo flujo)
  DOCUMENTS_AWAITING_EMAIL = 'DOCUMENTS_AWAITING_EMAIL',
  DOCUMENTS_AWAITING_DEPARTMENT = 'DOCUMENTS_AWAITING_DEPARTMENT',
  DOCUMENTS_MULTIPLE_CONDOMINIUMS = 'DOCUMENTS_MULTIPLE_CONDOMINIUMS',
  DOCUMENTS_AWAITING_CONDOMINIUM_SELECTION = 'DOCUMENTS_AWAITING_CONDOMINIUM_SELECTION',
  DOCUMENTS_AWAITING_DOCUMENT_SELECTION = 'DOCUMENTS_AWAITING_DOCUMENT_SELECTION',

  // Estados para estado de cuenta (nuevo flujo)
  ACCOUNT_AWAITING_EMAIL = 'ACCOUNT_AWAITING_EMAIL',
  ACCOUNT_AWAITING_DEPARTMENT = 'ACCOUNT_AWAITING_DEPARTMENT',
  ACCOUNT_MULTIPLE_CONDOMINIUMS = 'ACCOUNT_MULTIPLE_CONDOMINIUMS',
  ACCOUNT_AWAITING_CONDOMINIUM_SELECTION = 'ACCOUNT_AWAITING_CONDOMINIUM_SELECTION',
  ACCOUNT_GENERATING = 'ACCOUNT_GENERATING',

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
  possibleCondominiums?: Array<{
    clientId: string;
    condominiumId: string;
    condominiumName?: string;
  }>;
  selectedCondominium?: {
    clientId: string;
    condominiumId: string;
    condominiumName?: string;
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
  lastInteractionTimestamp?: admin.firestore.Timestamp;
  userId?: string;
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
            await this.registerPayment(context, fileUrl); // userId se añade dentro si es necesario
            context.state = ConversationState.COMPLETED;
            await this.sendAndLogMessage(
              {
                phoneNumber: from,
                message:
                  '✅ ¡Excelente! Hemos recibido tu imagen y registrado tu comprobante con éxito. ¡Muchas gracias! 🙌',
              },
              context,
            );
          } catch (uploadError) {
            this.logger.error(
              `Error al procesar imagen de ${from}: ${uploadError.message}`,
              uploadError.stack,
            );
            context.state = ConversationState.ERROR; // Marcar estado como error
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
              message:
                '🤔 Gracias por la imagen, pero no la esperaba ahora. Si necesitas registrar un pago, por favor escribe "Hola" para iniciar el proceso.',
            },
            context,
          ); // Pasar contexto para auditoría
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
            await this.registerPayment(context, fileUrl);
            context.state = ConversationState.COMPLETED;
            await this.sendAndLogMessage(
              {
                phoneNumber: from,
                message:
                  '✅ ¡Perfecto! Recibimos tu documento y hemos registrado tu comprobante exitosamente. ¡Gracias! 🥳',
              },
              context,
            );
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
              message:
                '📄 Gracias por el documento, pero no estaba esperando uno en este momento. Si quieres registrar un pago, escribe "Hola" para empezar. 😊',
            },
            context,
          );
        }
      } else {
        // Otros tipos (audio, video, etc.) -> no soportado
        await this.sendAndLogMessage(
          {
            phoneNumber: from,
            message:
              '😬 Lo siento, por ahora solo puedo procesar mensajes de texto, imágenes (como fotos de comprobantes) y documentos PDF. Si deseas ayuda, escribe "Hola".',
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

    // Reinicio global: si el usuario escribe "hola" o similar en cualquier estado (excepto inicial)
    if (this.isGreeting(text) && context.state !== ConversationState.INITIAL) {
      this.logger.log(
        `Usuario ${phoneNumber} solicitó reiniciar conversación.`,
      );
      // Reiniciar contexto
      this.resetContext(context);
    }

    switch (context.state) {
      case ConversationState.INITIAL:
        if (this.isGreeting(text)) {
          context.state = ConversationState.MENU_SELECTION;
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message: this.getMenuMessage(),
            },
            context,
          );
        } else {
          await this.sendAndLogMessage(
            {
              phoneNumber,
              message:
                '🤖 ¡Hola! Para comenzar, simplemente escribe "Hola" y te mostraré las opciones disponibles. ¡Estoy aquí para ayudarte! 😊',
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
              '⏳ Estoy esperando tu archivo (imagen JPG/PNG o PDF). Por favor, adjúntalo directamente en esta conversación para que pueda registrar tu pago. O si prefieres, escribe "Hola" para reiniciar.',
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

      case ConversationState.ACCOUNT_MULTIPLE_CONDOMINIUMS:
        await this.handleAccountMultipleCondominiums(context, text);
        break;

      case ConversationState.ACCOUNT_AWAITING_CONDOMINIUM_SELECTION:
        await this.handleAccountCondominiumSelection(context, text);
        break;

      case ConversationState.ACCOUNT_GENERATING:
        await this.handleAccountGenerating(context);
        break;

      case ConversationState.COMPLETED:
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '🎉 ¡Ya completaste tu consulta anterior! Si necesitas algo más, simplemente escribe "Hola" para ver el menú de opciones. ¡Estoy aquí para ayudarte!',
          },
          context,
        );
        break;

      case ConversationState.ERROR:
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '😥 Parece que hubo un error en nuestro sistema durante el proceso anterior. ¿Podrías por favor escribir "Hola" para intentarlo de nuevo? Disculpa las molestias.',
          },
          context,
        );
        this.resetContext(context);
        break;

      default:
        this.logger.warn(
          `Estado desconocido ${context.state} para ${phoneNumber}`,
        );
        this.resetContext(context);
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '🤔 Algo inesperado ocurrió. Vamos a empezar de nuevo. Escribe "Hola" para ver el menú.',
          },
          context,
        );
        break;
    }
  }

  // --- Nuevas funciones para el manejo del menú ---

  private getMenuMessage(): string {
    return `👋 ¡Hola! Bienvenido al asistente virtual de tu condominio. 

¿En qué puedo ayudarte hoy?

1️⃣ *Registrar comprobante de pago*
     Sube tu comprobante de pago para registro

2️⃣ *Consultar documentos*
     Accede al reglamento, manual de convivencia y políticas

3️⃣ *Estado de cuenta*
     Consulta tu estado de cuenta

Por favor, responde con el *número* de la opción que deseas (1, 2 o 3).`;
  }

  private async handleMenuSelection(
    context: ConversationContext,
    text: string,
  ) {
    const option = parseInt(text.trim(), 10);
    const { phoneNumber } = context;

    switch (option) {
      case 1:
        // Flujo de registro de comprobante
        context.state = ConversationState.PAYMENT_AWAITING_EMAIL;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '💳 *Registro de Comprobante de Pago*\n\n¡Perfecto! Vamos a registrar tu comprobante. Para empezar, ¿podrías proporcionarme tu correo electrónico registrado en la plataforma?',
          },
          context,
        );
        break;

      case 2:
        // Flujo de consulta de documentos
        context.state = ConversationState.DOCUMENTS_AWAITING_EMAIL;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '📚 *Consulta de Documentos*\n\n¡Excelente! Te ayudo a acceder a los documentos de tu condominio. Primero, necesito tu correo electrónico registrado en la plataforma.',
          },
          context,
        );
        break;

      case 3:
        // Flujo de consulta de estado de cuenta
        context.state = ConversationState.ACCOUNT_AWAITING_EMAIL;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '💵 *Consulta de Estado de Cuenta*\n\n¡Perfecto! Te ayudo a consultar tu estado de cuenta. Primero, necesito tu correo electrónico registrado en la plataforma.',
          },
          context,
        );
        break;

      default:
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '🤔 Opción no válida. Por favor, responde con:\n\n*1* para registrar comprobante\n*2* para consultar documentos\n*3* para consultar estado de cuenta\n\nO escribe "Hola" para ver el menú completo.',
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
    context.possibleCondominiums = undefined;
    context.selectedCondominium = undefined;
    context.pendingCharges = undefined;
    context.selectedChargeIds = undefined;
    context.availableDocuments = undefined;
    context.documentKeys = undefined;
    context.userId = undefined;
  }

  // --- Funciones para el flujo de pagos (adaptadas del código original) ---

  private async handlePaymentEmailInput(
    context: ConversationContext,
    text: string,
  ) {
    const { phoneNumber } = context;

    if (!this.isValidEmail(text)) {
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '📧 Parece que el correo electrónico no tiene un formato válido. ¿Podrías verificarlo e ingresarlo de nuevo, por favor? Asegúrate de que incluya un "@" y un dominio (ej. ".com").',
        },
        context,
      );
      return;
    }

    context.email = this.cleanInputKeepArroba(text);
    context.state = ConversationState.PAYMENT_AWAITING_DEPARTMENT;
    await this.sendAndLogMessage(
      {
        phoneNumber,
        message:
          '👍 ¡Correo recibido! Ahora, por favor, indícame tu número de departamento o casa (tal como está registrado en la plataforma).',
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
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '⚠️ No logré encontrar condominios asociados con la información que proporcionaste. Por favor, verifica que los datos sean correctos.',
          },
          context,
        );
        context.state = ConversationState.PAYMENT_AWAITING_EMAIL;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              'Vamos a intentarlo de nuevo. ¿Podrías darme tu correo electrónico registrado, por favor?',
          },
          context,
        );
        return;
      }

      context.userId = possibleCondos[0].userId;

      if (possibleCondos.length === 1) {
        context.selectedCondominium = possibleCondos[0];
        context.state = ConversationState.PAYMENT_AWAITING_CHARGE_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `✅ ¡Encontrado! Estás registrado en el condominio: ${possibleCondos[0].condominiumName || possibleCondos[0].condominiumId}. Ahora buscaré tus cargos pendientes...`,
          },
          context,
        );
        await this.showPendingCharges(context);
      } else {
        context.possibleCondominiums = possibleCondos;
        context.state =
          ConversationState.PAYMENT_AWAITING_CONDOMINIUM_SELECTION;
        await this.showCondominiumOptions(context, possibleCondos);
      }
    } catch (error) {
      this.logger.error(
        `Error buscando condominios para pagos en ${phoneNumber}: ${error.message}`,
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
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '📧 El formato del correo no parece correcto. ¿Podrías verificarlo e ingresarlo nuevamente? Debe incluir "@" y un dominio válido.',
        },
        context,
      );
      return;
    }

    context.email = this.cleanInputKeepArroba(text);
    context.state = ConversationState.DOCUMENTS_AWAITING_DEPARTMENT;
    await this.sendAndLogMessage(
      {
        phoneNumber,
        message:
          '👍 ¡Perfecto! Ahora necesito tu número de departamento o casa (como está registrado en la plataforma).',
      },
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
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '⚠️ No encontré información con los datos proporcionados. Verifiquemos tu correo electrónico.',
          },
          context,
        );
        context.state = ConversationState.DOCUMENTS_AWAITING_EMAIL;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              'Por favor, proporciona nuevamente tu correo electrónico registrado.',
          },
          context,
        );
        return;
      }

      context.userId = possibleCondos[0].userId;

      if (possibleCondos.length === 1) {
        context.selectedCondominium = possibleCondos[0];
        context.state = ConversationState.DOCUMENTS_AWAITING_DOCUMENT_SELECTION;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `✅ ¡Perfecto! Te encuentro registrado en: ${possibleCondos[0].condominiumName || possibleCondos[0].condominiumId}. Buscando documentos disponibles...`,
          },
          context,
        );
        await this.showAvailableDocuments(context);
      } else {
        context.possibleCondominiums = possibleCondos;
        context.state =
          ConversationState.DOCUMENTS_AWAITING_CONDOMINIUM_SELECTION;
        await this.showCondominiumOptions(context, possibleCondos);
      }
    } catch (error) {
      this.logger.error(
        `Error buscando condominios para documentos en ${phoneNumber}: ${error.message}`,
        error.stack,
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
      await this.sendAndLogMessage(
        {
          phoneNumber,
          message:
            '📧 El formato del correo no parece correcto. ¿Podrías verificarlo e ingresarlo nuevamente? Debe incluir "@" y un dominio válido.',
        },
        context,
      );
      return;
    }

    context.email = this.cleanInputKeepArroba(text);
    context.state = ConversationState.ACCOUNT_AWAITING_DEPARTMENT;
    await this.sendAndLogMessage(
      {
        phoneNumber,
        message:
          '👍 ¡Perfecto! Ahora necesito tu número de departamento o casa (como está registrado en la plataforma).',
      },
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
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              '⚠️ No encontré información con los datos proporcionados. Verifiquemos tu correo electrónico.',
          },
          context,
        );
        context.state = ConversationState.ACCOUNT_AWAITING_EMAIL;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message:
              'Por favor, proporciona nuevamente tu correo electrónico registrado.',
          },
          context,
        );
        return;
      }

      context.userId = possibleCondos[0].userId;

      if (possibleCondos.length === 1) {
        context.selectedCondominium = possibleCondos[0];
        context.state = ConversationState.ACCOUNT_GENERATING;
        await this.sendAndLogMessage(
          {
            phoneNumber,
            message: `✅ ¡Perfecto! Te encuentro registrado en: ${possibleCondos[0].condominiumName || possibleCondos[0].condominiumId}. Generando tu estado de cuenta... 📄`,
          },
          context,
        );
        await this.handleAccountGenerating(context);
      } else {
        context.possibleCondominiums = possibleCondos;
        context.state =
          ConversationState.ACCOUNT_AWAITING_CONDOMINIUM_SELECTION;
        await this.showCondominiumOptions(context, possibleCondos);
      }
    } catch (error) {
      this.logger.error(
        `Error buscando condominios para estado de cuenta en ${phoneNumber}: ${error.message}`,
        error.stack,
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

      const apiUrl = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
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
    }>,
  ) {
    const { phoneNumber } = context;

    let msg =
      '🔎 Tienes registro en múltiples condominios. Selecciona el correcto:\n\n';
    condominiums.forEach((condo, index) => {
      const name = condo.condominiumName
        ? `"${condo.condominiumName}"`
        : `(ID: ${condo.condominiumId})`;
      msg += `${index + 1}. Condominio ${name}\n`;
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
  private async findUserCondominiums(
    originalPhoneWithPrefix: string, // Ej: 52155...
    email?: string,
    departmentNumber?: string,
  ): Promise<Array<{
    clientId: string;
    condominiumId: string;
    userId: string;
    condominiumName?: string;
  }> | null> {
    if (!email || !departmentNumber) return null;

    const phoneForDB = this.toTenDigits(originalPhoneWithPrefix);
    const cleanedEmail = this.cleanInputKeepArroba(email);
    const cleanedDept = this.cleanInput(departmentNumber);

    this.logger.log('Buscando condominios para usuario con datos:', {
      phoneForDB,
      email: cleanedEmail,
      departmentNumber: cleanedDept,
    });

    try {
      const snapshot = await this.firestore
        .collectionGroup('users')
        .where('phone', '==', phoneForDB)
        .where('email', '==', cleanedEmail)
        .where('number', '==', cleanedDept)
        .get();

      this.logger.log(
        `Usuarios encontrados con la triple condición: ${snapshot.size}`,
      );

      if (snapshot.empty) {
        return [];
      }

      const results: Array<{
        clientId: string;
        condominiumId: string;
        userId: string;
        condominiumName?: string;
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

          results.push({ clientId, condominiumId, userId, condominiumName });
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
   */
  private async registerPayment(
    context: ConversationContext,
    fileUrl: string,
  ): Promise<void> {
    const {
      phoneNumber,
      email,
      departmentNumber,
      selectedCondominium,
      selectedChargeIds,
      userId,
    } = context;

    if (
      !selectedCondominium ||
      !selectedChargeIds ||
      !userId ||
      !email ||
      !departmentNumber
    ) {
      this.logger.error(
        `Faltan datos en el contexto para registrar el pago de ${phoneNumber}`,
      );
      await this.sendAndLogMessage(
        {
          phoneNumber: phoneNumber,
          message:
            '❗ Hubo un problema interno, parece que falta información para registrar tu pago. Por favor, inicia de nuevo con "Hola".',
        },
        context,
      );
      context.state = ConversationState.ERROR;
      return;
    }

    const { clientId, condominiumId } = selectedCondominium;
    const phoneForDB = this.toTenDigits(phoneNumber);

    const voucherData = {
      phoneNumber: phoneForDB,
      originalPhoneNumber: phoneNumber,
      email: this.cleanInputKeepArroba(email),
      departmentNumber: this.cleanInput(departmentNumber),
      userId: userId,
      paymentProofUrl: fileUrl,
      selectedChargeIds: selectedChargeIds,
      status: 'pending_review',
      uploadedBy: 'whatsapp-bot',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      condominiumName: selectedCondominium.condominiumName || null,
    };

    this.logger.log('Registrando comprobante de pago con datos:', {
      clientId,
      condominiumId,
      userId,
      chargeIds: selectedChargeIds.join(', '),
    });

    try {
      const voucherRef = await this.firestore
        .collection(
          `clients/${clientId}/condominiums/${condominiumId}/paymentsVouchers`,
        )
        .add(voucherData);
      this.logger.log(
        `Comprobante registrado con ID: ${voucherRef.id} para usuario ${userId}`,
      );
    } catch (error) {
      this.logger.error(
        `Error al guardar comprobante en Firestore para ${userId}: ${error.message}`,
        error.stack,
      );
      await this.sendAndLogMessage(
        {
          phoneNumber: phoneNumber,
          message:
            '❌ Ocurrió un error guardando tu comprobante en nuestra base de datos. Por favor, intenta adjuntar el archivo de nuevo. Si persiste, contacta a soporte.',
        },
        context,
      );
      context.state = ConversationState.ERROR;
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
}
