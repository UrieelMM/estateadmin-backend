import { MailerSend, EmailParams, Recipient, Sender } from 'mailersend';
import * as admin from 'firebase-admin';

export class ChargeNotificationService {
  private mailerSend: any;

  constructor() {
    this.mailerSend = new MailerSend({
      apiKey:
        process.env.MAILERSEND_API_KEY ||
        'mlsn.f2c00dfb3c09f09eb41eaaa73a9ec599aa03fe4e62de1c64e3c1fc7c73af4eaa',
    });
  }

  /**
   * Formatea un valor numérico a formato de moneda mexicana
   * @param value Valor en centavos
   * @returns String formateado como moneda mexicana
   */
  private formatCurrency(value: any): string {
    if (!value && value !== 0) return '$0.00';

    // Convertir de centavos a pesos
    const numValue =
      typeof value === 'number' ? value / 100 : parseFloat(value) / 100;
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN',
      minimumFractionDigits: 2,
    }).format(numValue);
  }

  /**
   * Formatea una fecha string al formato de fecha legible en español
   * @param dateString String de fecha en formato "YYYY-MM-DD HH:MM"
   * @returns Fecha formateada en español
   */
  private formatDate(dateString: string): string {
    if (!dateString) return 'Fecha no disponible';

    try {
      const date = new Date(dateString.replace(' ', 'T'));
      return new Intl.DateTimeFormat('es-MX', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }).format(date);
    } catch (error) {
      console.error('Error al formatear la fecha:', error);
      return dateString;
    }
  }

  /**
   * Verifica si el usuario desea recibir notificaciones por email
   * @param clientId ID del cliente
   * @param condominiumId ID del condominio
   * @param userId ID del usuario o null si se debe buscar por email
   * @param email Email del usuario para buscar si no se tiene userId
   * @returns Objeto con la preferencia de notificación y datos del usuario
   */
  async checkUserNotificationPreference(
    clientId: string,
    condominiumId: string,
    userId: string | null,
    email: string,
  ): Promise<{ wantsEmailNotifications: boolean; userData: any | null }> {
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
        return { wantsEmailNotifications: false, userData: null };
      }

      const userData = userDoc.data();
      // Verificar si el usuario quiere recibir notificaciones por email
      const wantsEmailNotifications = userData?.notifications?.email === true;

      return { wantsEmailNotifications, userData };
    } catch (error) {
      console.error('Error al verificar preferencias de notificación:', error);
      // Por defecto, asumimos que no quiere notificaciones en caso de error
      return { wantsEmailNotifications: false, userData: null };
    }
  }

  /**
   * Obtiene el mensaje personalizado de pago del condominio
   * @param clientId ID del cliente
   * @param condominiumId ID del condominio
   * @returns Mensaje personalizado o null si no existe
   */
  async getPaymentMessage(
    clientId: string,
    condominiumId: string,
  ): Promise<string | null> {
    try {
      const configRef = admin
        .firestore()
        .doc(
          `clients/${clientId}/condominiums/${condominiumId}/paymentMessageInfo/config`,
        );
      const configDoc = await configRef.get();

      if (!configDoc.exists) {
        return null;
      }

      const configData = configDoc.data();
      return configData?.paymentMessage || null;
    } catch (error) {
      console.error('Error al obtener mensaje de pago personalizado:', error);
      return null;
    }
  }

  /**
   * Envía un correo electrónico de notificación de cargo
   * @param email Correo electrónico del destinatario
   * @param userName Nombre del usuario
   * @param chargeData Datos del cargo
   * @param clientId ID del cliente
   * @param condominiumId ID del condominio
   * @param userId ID del usuario (opcional)
   */
  async sendChargeNotificationEmail(
    email: string,
    userName: string,
    chargeData: any,
    clientId: string,
    condominiumId: string,
    userId?: string,
  ): Promise<void> {
    try {
      // Verificar si el usuario desea recibir notificaciones por email
      const { wantsEmailNotifications } =
        await this.checkUserNotificationPreference(
          clientId,
          condominiumId,
          userId || null,
          email,
        );

      if (!wantsEmailNotifications) {
        console.log(
          `El usuario ${email} ha desactivado las notificaciones por email.`,
        );
        return;
      }

      // Obtener mensaje personalizado de pago
      const paymentMessage = await this.getPaymentMessage(
        clientId,
        condominiumId,
      );

      // Generar la plantilla HTML del correo
      const emailHtml = this.generateChargeEmailTemplate(
        userName,
        chargeData,
        paymentMessage,
      );

      // Configurar los parámetros del correo
      const emailParams = new EmailParams()
        .setFrom(new Sender('MS_CUXpzj@estate-admin.com', 'EstateAdmin'))
        .setTo([new Recipient(email, userName)])
        .setSubject('Nuevo Cargo en tu Cuenta - EstateAdmin')
        .setHtml(emailHtml);

      // Enviar el correo
      await this.mailerSend.email.send(emailParams);
      console.log(`Correo de notificación de cargo enviado a: ${email}`);
    } catch (error) {
      console.error(
        'Error al enviar el correo de notificación de cargo:',
        error,
      );
      throw error;
    }
  }

  /**
   * Genera la plantilla HTML para el correo de notificación de cargo
   * @param userName Nombre del usuario
   * @param chargeData Datos del cargo
   * @param paymentMessage Mensaje personalizado de pago (opcional)
   * @returns Plantilla HTML del correo
   */
  private generateChargeEmailTemplate(
    userName: string,
    chargeData: any,
    paymentMessage?: string | null,
  ): string {
    const amount = this.formatCurrency(chargeData.amount);
    const concept = chargeData.concept || 'Cargo';
    const dueDate = this.formatDate(chargeData.dueDate);
    const generatedAt = chargeData.generatedAt
      ? new Date(
          chargeData.generatedAt.seconds
            ? chargeData.generatedAt.seconds * 1000
            : chargeData.generatedAt,
        ).toLocaleDateString('es-ES')
      : new Date().toLocaleDateString('es-ES');

    return `
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: 'Open Sans', sans-serif; margin:0; padding:0; background-color: #f6f6f6; }
          .container { width: 90%; max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 10px; padding: 20px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); }
          .header { background-color: #6366F1; padding: 20px; border-radius: 10px 10px 0 0; text-align: center; }
          .header img { width: 100px; height: auto; }
          .header h1 { color: #ffffff; margin: 0; font-size: 24px; }
          .content { padding: 20px; }
          .details-table { width: 100%; border-collapse: collapse; }
          .details-table th, .details-table td { padding:8px; border-bottom: 1px solid #ddd; text-align: left; }
          .details-table th { background-color: #6366F1; color: #ffffff; text-align: left; }
          .details-table tr:nth-child(odd) { background-color: #f9f9f9; }
          .button { background-color: #6366F1; color: #ffffff; text-decoration: none; padding: 15px; display: block; text-align: center; border-radius: 5px; margin: 20px 0; }
          .footer { text-align: center; font-size: 14px; color: #666666; margin-top: 20px; }
          @media (max-width: 600px) {
            .header h1 { font-size: 20px; }
            .details-table th, .details-table td { font-size: 12px; padding: 5px; }
            .button { padding: 10px; font-size: 16px; }
            .container { padding: 10px; }
          }
        </style>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300;0,400;0,600;0,700;0,800&display=swap" rel="stylesheet">
      </head>
      <body>
        <div class="container">
          <div class="header">
            <img src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521" alt="EstateAdmin">
            <h1>Nuevo Cargo en tu Cuenta</h1>
          </div>
          <div class="content" style="padding:20px; background-color: #f6f6f6; margin-top:20px; border-radius: 10px;">
            <h2 style="color:#1a1a1a; font-size:20px;">Hola, ${userName}</h2>
            <p style="color:#1a1a1a; font-size:16px;">Te informamos que se ha generado un nuevo cargo en tu cuenta.</p>
            
            <table class="details-table">
              <tr>
                <th>Concepto</th>
                <th>Monto</th>
                <th>Fecha Límite de Pago</th>
              </tr>
              <tr>
                <td>${concept}</td>
                <td style="font-weight: bold;">${amount}</td>
                <td style="font-weight: bold;">${dueDate}</td>
              </tr>
            </table>
            
            <!-- Fecha en que se generó el cargo -->
            <table style="width:100%; border-collapse: collapse; margin-top: 20px;">
              <tr>
                <td style="padding:8px; text-align:left; color: #1a1a1a; border-bottom: 1px solid #ddd; border-top: 1px solid #ddd; font-weight: bold; background-color: #f9f9f9;">
                  Fecha en que se generó el cargo: ${generatedAt}
                </td>
              </tr>
            </table>
            
            ${
              paymentMessage
                ? `${paymentMessage}`
                : `
            <p style="margin-top: 20px;">Te recordamos que puedes realizar tu pagon directamente con tu administrador.</p>
            <br />
            <p>Si tienes alguna duda sobre este cargo, por favor contacta a tu administrador.</p>
            `
            }
          </div>
          
          <div class="footer" style="background-color:#f6f6f6;border-radius:10px 10px 0 0;padding:10px;text-align:center; color:#1a1a1a">
            <p>Modernidad y Eficacia en la Administración</p>
            <p>Síguenos en nuestras redes sociales: 
              <a href="#" style="color:#6366F1; text-decoration:none;">Facebook</a> | 
              <a href="#" style="color:#6366F1; text-decoration:none;">Twitter</a> | 
              <a href="#" style="color:#6366F1; text-decoration:none;">Instagram</a>
            </p>
            <p>© ${new Date().getFullYear()} EstateAdmin. Todos los derechos reservados.</p>
          </div>
        </div>
      </body>
    </html>
    `;
  }
}
