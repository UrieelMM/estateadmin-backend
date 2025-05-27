import { MailerSend, EmailParams, Recipient, Sender } from 'mailersend';
import * as admin from 'firebase-admin';
// @ts-ignore
const twilio = require('twilio');
import { defineString, defineSecret } from 'firebase-functions/params';

export class CalendarEventService {
  private mailerSend: any;
  private TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
  private TWILIO_ACCOUNT_SID = defineString('TWILIO_ACCOUNT_SID');
  private TWILIO_MESSAGING_SERVICE_SID = defineString(
    'TWILIO_MESSAGING_SERVICE_SID',
  );

  constructor() {
    this.mailerSend = new MailerSend({
      apiKey:
        process.env.MAILERSEND_API_KEY ||
        'mlsn.3611aa51c08f244faf71131ceb627e193d3f57183323b0cb39538532bd6abfa7',
    });
  }

  /**
   * Formatea números de teléfono mexicanos
   * @param phone Número de teléfono
   * @returns Número formateado
   */
  private formatPhoneNumber(phone: any): string {
    if (!phone) return '';

    // Asegurarse de que phone sea una cadena de texto
    const phoneStr = String(phone);

    // Eliminar cualquier carácter que no sea número
    const cleanPhone = phoneStr.replace(/\D/g, '');

    // Si el número ya tiene el prefijo +521, lo devolvemos tal cual
    if (cleanPhone.startsWith('521')) {
      return `+${cleanPhone}`;
    }
    // Si el número comienza con 52, agregamos el 1
    if (cleanPhone.startsWith('52')) {
      return `+${cleanPhone}`;
    }
    // Si el número comienza con 1, agregamos el 52
    if (cleanPhone.startsWith('1')) {
      return `+52${cleanPhone}`;
    }
    // Para cualquier otro caso, asumimos que es un número local y agregamos +521
    return `+521${cleanPhone}`;
  }

  /**
   * Formatea una fecha en formato "DD Mes YYYY"
   * @param dateString Fecha en formato "YYYY-MM-DD"
   * @returns Fecha formateada
   */
  private formatDateForWhatsApp(dateString: string): string {
    if (!dateString) return 'fecha no especificada';

    try {
      const date = new Date(dateString);

      // Verificar si la fecha es válida
      if (isNaN(date.getTime())) {
        return dateString; // Devolver la fecha original si no es válida
      }

      // Array de nombres de meses en español
      const meses = [
        'Enero',
        'Febrero',
        'Marzo',
        'Abril',
        'Mayo',
        'Junio',
        'Julio',
        'Agosto',
        'Septiembre',
        'Octubre',
        'Noviembre',
        'Diciembre',
      ];

      // Obtener día, mes y año
      const dia = date.getDate();
      const mes = meses[date.getMonth()];
      const anio = date.getFullYear();

      // Formato "DD Mes YYYY"
      return `${dia} ${mes} ${anio}`;
    } catch (error) {
      console.error('Error al formatear la fecha:', error);
      return dateString; // Devolver la fecha original en caso de error
    }
  }

  /**
   * Verifica si el usuario desea recibir notificaciones
   * @param clientId ID del cliente
   * @param condominiumId ID del condominio
   * @param userId ID del usuario o null si se debe buscar por email
   * @param email Email del usuario para buscar si no se tiene userId
   * @returns Objeto con las preferencias de notificación y datos del usuario
   */
  async checkUserNotificationPreference(
    clientId: string,
    condominiumId: string,
    userId: string | null,
    email: string,
  ): Promise<{
    wantsEmailNotifications: boolean;
    wantsWhatsAppNotifications: boolean;
    userData: any | null;
  }> {
    try {
      let userDoc;

      if (userId) {
        // Si tenemos userId, buscamos directamente por ID
        const userRef = admin
          .firestore()
          .doc(
            `clients/${clientId}/condominiums/${condominiumId}/users/${userId}`,
          );
        userDoc = await userRef.get();
      } else {
        // Si no tenemos userId, buscamos por email
        const usersRef = admin
          .firestore()
          .collection(
            `clients/${clientId}/condominiums/${condominiumId}/users`,
          );
        const querySnapshot = await usersRef
          .where('email', '==', email)
          .limit(1)
          .get();

        if (!querySnapshot.empty) {
          userDoc = querySnapshot.docs[0];
        }
      }

      if (!userDoc || !userDoc.exists) {
        console.log(`No se encontró el usuario con email: ${email}`);
        return {
          wantsEmailNotifications: false,
          wantsWhatsAppNotifications: false,
          userData: null,
        };
      }

      const userData = userDoc.data();
      // Verificar si el usuario quiere recibir notificaciones
      const wantsEmailNotifications = userData?.notifications?.email === true;
      const wantsWhatsAppNotifications =
        userData?.notifications?.whatsapp === true;

      return { wantsEmailNotifications, wantsWhatsAppNotifications, userData };
    } catch (error) {
      console.error('Error al verificar preferencias de notificación:', error);
      // Por defecto, asumimos que no quiere notificaciones en caso de error
      return {
        wantsEmailNotifications: false,
        wantsWhatsAppNotifications: false,
        userData: null,
      };
    }
  }

  /**
   * Envía notificación por WhatsApp sobre un evento de calendario
   * @param userData Datos del usuario
   * @param eventData Datos del evento
   * @returns Resultado del envío
   */
  async sendWhatsAppNotification(userData: any, eventData: any): Promise<any> {
    try {
      const userPhone = userData.phoneNumber || userData.phone;
      if (!userPhone) {
        console.log('No se encontró número de teléfono para el usuario');
        return null;
      }

      console.log(
        'Datos originales del evento:',
        JSON.stringify(eventData, null, 2),
      );

      // Preparar datos para el template
      const areaName = eventData.commonArea || 'área común';
      // Formatear la fecha al formato requerido por WhatsApp
      const eventDate = this.formatDateForWhatsApp(eventData.eventDay || '');
      const folio =
        eventData.folio ||
        eventData.id ||
        `EA-${Math.random().toString(36).substring(2, 12).toUpperCase()}`;

      const accountSid = this.TWILIO_ACCOUNT_SID.value();
      const authToken = this.TWILIO_AUTH_TOKEN.value();
      const messagingServiceSid = this.TWILIO_MESSAGING_SERVICE_SID.value();

      if (!accountSid || !authToken || !messagingServiceSid) {
        console.error(
          'Faltan credenciales de Twilio en las variables de entorno',
        );
        return null;
      }

      // Inicializar el cliente de Twilio
      const clientTwilio = require('twilio')(accountSid, authToken);

      console.log(
        'Enviando mensaje de WhatsApp a:',
        this.formatPhoneNumber(userPhone),
      );

      // Enviar el mensaje usando el template aprobado
      // Importante: contentVariables debe ser un string y NO un objeto JSON
      const message = await clientTwilio.messages.create({
        messagingServiceSid: messagingServiceSid,
        to: `whatsapp:${this.formatPhoneNumber(userPhone)}`,
        contentSid: 'HX277e20e64c6d6285aaaeeb098e0d23cf',
        contentVariables: JSON.stringify({
          1: areaName,
          2: eventDate,
          3: folio,
        }),
      });

      console.log(`Mensaje de WhatsApp enviado con SID: ${message.sid}`);
      return message;
    } catch (whatsappError) {
      console.error('Error al enviar el mensaje de WhatsApp:', whatsappError);
      console.error(
        'Detalles del error:',
        JSON.stringify(whatsappError, null, 2),
      );
      return null;
    }
  }

  /**
   * Genera la plantilla HTML para el correo de notificación de evento
   * @param userData Datos del usuario
   * @param eventData Datos del evento
   * @returns Plantilla HTML del correo
   */
  private generateEventEmailTemplate(userData: any, eventData: any): string {
    return `
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap');
            
            body { 
              font-family: 'Poppins', sans-serif; 
              margin: 0; 
              padding: 0; 
              background-color: #f5f7fa; 
              color: #333;
              line-height: 1.6;
            }
            
            .container { 
              max-width: 600px; 
              margin: 40px auto; 
              background-color: #ffffff; 
              border-radius: 16px; 
              overflow: hidden;
              box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
            }
            
            .header { 
              background-color: #6366F1; 
              padding: 30px 20px; 
              text-align: center; 
            }
            
            .header img { 
              width: 120px; 
              height: auto; 
              margin-bottom: 15px;
            }
            
            .header h1 { 
              color: #ffffff; 
              margin: 0; 
              font-size: 24px; 
              font-weight: 600;
              letter-spacing: 0.5px;
            }
            
            .content { 
              padding: 40px 30px; 
              background-color: #ffffff;
            }
            
            .greeting {
              font-size: 22px;
              font-weight: 600;
              color: #2d3748;
              margin-bottom: 15px;
            }
            
            .message {
              font-size: 16px;
              color: #4a5568;
              margin-bottom: 30px;
            }
            
            .event-card {
              background-color: #f8fafc;
              border-radius: 12px;
              padding: 25px;
              margin-bottom: 30px;
              border-left: 4px solid #6366F1;
            }
            
            .event-title {
              font-size: 18px;
              font-weight: 600;
              color: #2d3748;
              margin-bottom: 20px;
            }
            
            .event-detail {
              display: flex;
              margin-bottom: 15px;
              align-items: flex-start;
            }
            
            .detail-icon {
              flex: 0 0 24px;
              color: #6366F1;
              margin-right: 12px;
              font-weight: bold;
            }
            
            .detail-label {
              flex: 0 0 120px;
              font-weight: 500;
              color: #4a5568;
            }
            
            .detail-value {
              flex: 1;
              color: #1a202c;
            }
            
            .success-message {
              background-color: #6366F1;
              color: white;
              padding: 16px 20px;
              border-radius: 8px;
              font-weight: 500;
              text-align: center;
              margin-top: 30px;
            }
            
            .footer {
              background-color: #f8fafc;
              padding: 25px 20px;
              text-align: center;
              font-size: 14px;
              color: #718096;
              border-top: 1px solid #e2e8f0;
            }
            
            .social-links {
              margin: 15px 0;
            }
            
            .social-links a {
              color: #6366F1;
              text-decoration: none;
              margin: 0 10px;
              font-weight: 500;
            }
            
            .company {
              font-weight: 600;
              margin-top: 10px;
            }
            
            @media (max-width: 600px) {
              .content {
                padding: 30px 20px;
              }
              
              .event-card {
                padding: 20px 15px;
              }
              
              .detail-label {
                flex: 0 0 100px;
              }
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <img src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521" alt="EstateAdmin">
              <h1>Nueva Reserva Registrada</h1>
            </div>
            
            <div class="content">
              <div class="greeting">Hola, ${userData.name || 'Residente'}</div>
              <div class="message">Se ha registrado exitosamente tu reserva para un área común en tu condominio.</div>
              
              <div class="event-card">
                <div class="event-title">${eventData.name || 'Evento'}</div>
                
                <div class="event-detail">
                  <div class="detail-icon">📅</div>
                  <div class="detail-label">Fecha:</div>
                  <div class="detail-value">${this.formatDateForWhatsApp(eventData.eventDay) || 'No especificada'}</div>
                </div>
                
                <div class="event-detail">
                  <div class="detail-icon">⏰</div>
                  <div class="detail-label">Horario:</div>
                  <div class="detail-value">${eventData.startTime || '00:00'} - ${eventData.endTime || '00:00'}</div>
                </div>
                
                <div class="event-detail">
                  <div class="detail-icon">🏠</div>
                  <div class="detail-label">Área:</div>
                  <div class="detail-value">${eventData.commonArea || 'No especificada'}</div>
                </div>
                
                <div class="event-detail">
                  <div class="detail-icon">🏢</div>
                  <div class="detail-label">Número:</div>
                  <div class="detail-value">${eventData.number || 'N/A'}</div>
                </div>
                
                ${
                  eventData.comments
                    ? `
                <div class="event-detail">
                  <div class="detail-icon">💬</div>
                  <div class="detail-label">Comentarios:</div>
                  <div class="detail-value">${eventData.comments}</div>
                </div>
                `
                    : ''
                }
              </div>
              
              <div class="success-message">
                ¡Tu reserva ha sido registrada exitosamente!
              </div>
            </div>
            
            <div class="footer">
              <div>Modernidad y Eficacia en la Administración</div>
              <div class="social-links">
                <a href="URL_FACEBOOK">Facebook</a> | 
                <a href="URL_TWITTER">Twitter</a> | 
                <a href="URL_INSTAGRAM">Instagram</a>
              </div>
              <div class="company">Omnipixel</div>
            </div>
          </div>
        </body>
      </html>
    `;
  }

  /**
   * Envía un correo electrónico de notificación de evento
   * @param email Correo electrónico del destinatario
   * @param userData Datos del usuario
   * @param eventData Datos del evento
   * @returns Resultado del envío
   */
  async sendEmailNotification(
    email: string,
    userData: any,
    eventData: any,
  ): Promise<any> {
    try {
      // Generar la plantilla HTML del correo
      const emailHtml = this.generateEventEmailTemplate(userData, eventData);

      // Configurar los parámetros del correo
      const emailParams = new EmailParams()
        .setFrom(
          new Sender(
            'MS_Fpa0aS@notifications.estate-admin.com',
            'EstateAdmin Notifications',
          ),
        )
        .setTo([new Recipient(email, userData.name || 'Residente')])
        .setReplyTo(
          new Sender(
            'MS_Fpa0aS@notifications.estate-admin.com',
            'EstateAdmin Notifications',
          ),
        )
        .setSubject(`Nuevo Evento en Condominio`)
        .setHtml(emailHtml);

      // Enviar el correo
      await this.mailerSend.email.send(emailParams);
      console.log(`Correo enviado exitosamente a ${email}`);
      return true;
    } catch (error) {
      console.error('Error al enviar el correo:', error);
      return false;
    }
  }
}
